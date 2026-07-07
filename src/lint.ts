import type { ZodType } from "zod";

import { lintPublicSchemaFieldNames } from "./public-schema-field-lint";
import {
	APIFUSE_DESCRIPTION_KEY_META_KEY,
	APIFUSE_SENSITIVE_META_KEY,
} from "./schema";

type AuthModeLike =
	| "none"
	| "platform-managed"
	| "credentials"
	| "oauth2"
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

const AUTH_OPERATION_ID_PATTERN =
	/^(?:auth[-_])?(?:login|exchange|continue|refresh|callback)(?:[-_]|$)/i;

type ProviderContractMetaLike = {
	publicSchemaFieldNames?: "normalized";
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

function lintNativeTcpEgress(
	providerId: string | undefined,
	native:
		| {
				network?: {
					tcp?: readonly unknown[];
				};
		  }
		| undefined,
): LintDiagnostic[] {
	const rules = native?.network?.tcp;
	if (rules === undefined) return [];
	const prefix = providerId ? `Provider "${providerId}"` : "Provider";
	if (!Array.isArray(rules)) {
		return [
			{
				rule: "native-tcp-egress-array",
				level: "error",
				field: "native.network.tcp",
				message: `${prefix} native.network.tcp must be an array.`,
			},
		];
	}

	const diagnostics: LintDiagnostic[] = [];
	for (const [index, rule] of rules.entries()) {
		const field = `native.network.tcp[${index}]`;
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
			diagnostics.push({
				rule: "native-tcp-egress-object",
				level: "error",
				field,
				message: `${prefix} ${field} must be an object.`,
			});
			continue;
		}
		const record = rule as Record<string, unknown>;
		const host = record.host;
		if (typeof host !== "string" || host.trim().length === 0) {
			diagnostics.push({
				rule: "native-tcp-egress-host",
				level: "error",
				field: `${field}.host`,
				message: `${prefix} ${field}.host must be a non-empty host.`,
			});
		} else if (host.includes("*")) {
			diagnostics.push({
				rule: "native-tcp-egress-no-wildcards",
				level: "error",
				field: `${field}.host`,
				message: `${prefix} ${field}.host must not contain wildcards.`,
			});
		}

		const ports = record.ports;
		if (!Array.isArray(ports) || ports.length === 0) {
			diagnostics.push({
				rule: "native-tcp-egress-ports",
				level: "error",
				field: `${field}.ports`,
				message: `${prefix} ${field}.ports must be a non-empty array.`,
			});
		} else {
			for (const port of ports) {
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					diagnostics.push({
						rule: "native-tcp-egress-port",
						level: "error",
						field: `${field}.ports`,
						message: `${prefix} ${field}.ports contains invalid port "${String(port)}".`,
					});
					break;
				}
			}
		}

		if (
			record.tls !== "required" &&
			record.tls !== "allowed" &&
			record.tls !== "disabled"
		) {
			diagnostics.push({
				rule: "native-tcp-egress-tls",
				level: "error",
				field: `${field}.tls`,
				message: `${prefix} ${field}.tls must be "required", "allowed", or "disabled".`,
			});
		}
	}
	return diagnostics;
}

function lintNativeTcpDynamicEgress(
	providerId: string | undefined,
	native:
		| {
				network?: {
					dynamicTcp?: readonly unknown[];
				};
		  }
		| undefined,
): LintDiagnostic[] {
	const rules = native?.network?.dynamicTcp;
	if (rules === undefined) return [];
	const prefix = providerId ? `Provider "${providerId}"` : "Provider";
	if (!Array.isArray(rules)) {
		return [
			{
				rule: "native-dynamic-tcp-egress-array",
				level: "error",
				field: "native.network.dynamicTcp",
				message: `${prefix} native.network.dynamicTcp must be an array.`,
			},
		];
	}

	const diagnostics: LintDiagnostic[] = [];
	for (const [index, rule] of rules.entries()) {
		const field = `native.network.dynamicTcp[${index}]`;
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
			diagnostics.push({
				rule: "native-dynamic-tcp-egress-object",
				level: "error",
				field,
				message: `${prefix} ${field} must be an object.`,
			});
			continue;
		}
		const record = rule as Record<string, unknown>;
		const sourceHost = record.sourceHost;
		if (typeof sourceHost !== "string" || sourceHost.trim().length === 0 || sourceHost.includes("*")) {
			diagnostics.push({
				rule: "native-dynamic-tcp-egress-source-host",
				level: "error",
				field: `${field}.sourceHost`,
				message: `${prefix} ${field}.sourceHost must be a non-empty exact host without wildcards.`,
			});
		}
		const sourcePorts = record.sourcePorts;
		if (!Array.isArray(sourcePorts) || sourcePorts.length === 0) {
			diagnostics.push({
				rule: "native-dynamic-tcp-egress-source-ports",
				level: "error",
				field: `${field}.sourcePorts`,
				message: `${prefix} ${field}.sourcePorts must be a non-empty array.`,
			});
		}
		const suffixes = record.targetHostSuffixes;
		if (!Array.isArray(suffixes) || suffixes.length === 0 || suffixes.some((suffix) => typeof suffix !== "string" || suffix.trim().length === 0 || suffix.includes("*"))) {
			diagnostics.push({
				rule: "native-dynamic-tcp-egress-target-suffixes",
				level: "error",
				field: `${field}.targetHostSuffixes`,
				message: `${prefix} ${field}.targetHostSuffixes must contain exact suffixes without wildcards.`,
			});
		}
		const targetPorts = record.targetPorts;
		const targetPortRanges = record.targetPortRanges;
		if (
			(!Array.isArray(targetPorts) || targetPorts.length === 0) &&
			(!Array.isArray(targetPortRanges) || targetPortRanges.length === 0)
		) {
			diagnostics.push({
				rule: "native-dynamic-tcp-egress-target-ports",
				level: "error",
				field,
				message: `${prefix} ${field} must declare targetPorts or targetPortRanges.`,
			});
		}
		if (record.tls !== "required" && record.tls !== "allowed" && record.tls !== "disabled") {
			diagnostics.push({
				rule: "native-dynamic-tcp-egress-tls",
				level: "error",
				field: `${field}.tls`,
				message: `${prefix} ${field}.tls must be "required", "allowed", or "disabled".`,
			});
		}
	}
	return diagnostics;
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
		/(access_token|refresh_token|password|secret|cookie|session|token|api[_-]?key)/i.test(
			key,
		),
	);
}

function hasReusableReloginSecretKeys(
	keys: readonly string[] | undefined,
): boolean {
	if (!keys) {
		return false;
	}

	return keys.some((key) =>
		/(password|passcode|secret|cookie|session)/i.test(key),
	);
}

function getAuthFlowSource(provider: {
	auth?: ProviderAuthLike;
	authFlowSource?: string;
}): string {
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
		.filter(
			(part): part is (...args: unknown[]) => unknown =>
				typeof part === "function",
		)
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
		(!provider.credential?.storesReusableSecret ||
			!provider.credential.justification)
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
		(!provider.credential?.storesReusableSecret ||
			!provider.credential.justification)
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
	if (
		authFlowSource.includes("ctx.context") &&
		(provider.context?.keys?.length ?? 0) === 0
	) {
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
	const rawShape =
		typeof schema.shape === "function" ? schema.shape() : schema.shape;
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

function getChildSchemas(
	schema: SchemaLike,
): Array<{ key: string; schema: SchemaLike }> {
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
	const value = Reflect.get(
		getSchemaMetadata(schema),
		APIFUSE_DESCRIPTION_KEY_META_KEY,
	);
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
			...collectSchemaDescriptionKeyDiagnostics(
				child.schema,
				childPath,
				seen,
				!isStructuralNode,
			),
		);
	}

	return diagnostics;
}

function isComplexSchema(
	schema: unknown,
	seen = new Set<SchemaLike>(),
): boolean {
	if (!isSchema(schema) || seen.has(schema)) {
		return false;
	}

	seen.add(schema);
	const children = getChildSchemas(schema);
	const hasNestedComposite = children.some(({ schema: child }) => {
		const childChildren = getChildSchemas(child);
		return childChildren.length > 0;
	});

	return (
		hasNestedComposite ||
		children.some(({ schema: child }) => isComplexSchema(child, seen))
	);
}

function hasBidirectionalFixtures(fixtures: unknown): boolean {
	if (!fixtures || typeof fixtures !== "object") {
		return true;
	}

	return "request" in fixtures && "response" in fixtures;
}

function getOperationSource(operation: {
	handler?: unknown;
	source?: string;
}): string {
	if (operation.source) {
		return operation.source;
	}
	return typeof operation.handler === "function"
		? operation.handler.toString()
		: "";
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
	return Object.entries(provider.operations).flatMap(
		([operationKey, operation]) => {
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
		},
	);
}

function lintCredentialWriteUsage(provider: {
	operations?: Record<string, { handler?: unknown; source?: string }>;
}): LintDiagnostic[] {
	if (!provider.operations) {
		return [];
	}

	return Object.entries(provider.operations).flatMap(
		([operationKey, operation]) => {
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
		},
	);
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

	for (const [filePath, source] of Object.entries(
		provider.providerSourceFiles ?? {},
	)) {
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

	for (const [filePath, source] of Object.entries(
		provider.providerSourceFiles ?? {},
	)) {
		sources.push({ field: `sourceFiles.${filePath}`, source });
	}

	for (const [operationKey, operation] of Object.entries(
		provider.operations ?? {},
	)) {
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
	const hasDescriptionKey =
		typeof op.descriptionKey === "string" && op.descriptionKey.length > 0;

	if (description.trim().length > 0 && !hasDescriptionKey) {
		diagnostics.push({
			rule: "operation-description-raw-prose",
			level: "error",
			field: "description",
			message:
				"Operation description must use descriptionKey instead of raw static prose.",
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
			message:
				"Operation whenToUse must use whenToUseKeys instead of raw static prose.",
		});
	}

	if (
		(op.whenNotToUse?.length ?? 0) > 0 &&
		!(op.whenNotToUseKeys?.length ?? 0)
	) {
		diagnostics.push({
			rule: "operation-when-not-to-use-raw-prose",
			level: "error",
			field: "whenNotToUse",
			message:
				"Operation whenNotToUse must use whenNotToUseKeys instead of raw static prose.",
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
			message:
				"Complex input schemas should provide at least 2 input examples.",
		});
	}

	for (const field of uniqueFields(
		collectUnmarkedSensitiveFields(op.input, "input"),
	)) {
		diagnostics.push({
			rule: "sensitive-field-unmarked",
			level: "warn",
			field,
			message: `Schema field "${field}" looks sensitive; mark it with fields.*(), field(..., { sensitive: true }), or sensitive(...).`,
		});
	}

	for (const field of uniqueFields(
		collectUnmarkedSensitiveFields(op.output, "output"),
	)) {
		diagnostics.push({
			rule: "sensitive-field-unmarked",
			level: "warn",
			field,
			message: `Schema field "${field}" looks sensitive; mark it with fields.*(), field(..., { sensitive: true }), or sensitive(...).`,
		});
	}

	return diagnostics;
}

export function lintProvider(
	provider: {
		id?: string;
		allowedHosts?: readonly string[];
		native?: {
			network?: {
				tcp?: readonly unknown[];
				dynamicTcp?: readonly unknown[];
			};
		};
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
			}
		>;
		meta?: {
			contract?: ProviderContractMetaLike;
		};
		reviewed?: string;
	},
	options: ProviderLintOptions = {},
): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [
		...lintAllowedHosts(provider.id, provider.allowedHosts),
		...lintNativeTcpEgress(provider.id, provider.native),
		...lintNativeTcpDynamicEgress(provider.id, provider.native),
		...lintReviewed(provider.id, provider.reviewed),
		...lintAuthModel(provider),
		...lintStealthTransportUsage(provider),
		...lintCredentialWriteUsage(provider),
		...lintPlaywrightDirectImports(provider),
		...lintSelfHostedBrowserPatterns(provider, options),
	];

	if (provider.operations) {
		const authMode = provider.auth?.mode;
		if (authMode === "credentials" || authMode === "oauth2") {
			for (const operationKey of Object.keys(provider.operations)) {
				if (AUTH_OPERATION_ID_PATTERN.test(operationKey)) {
					diagnostics.push({
						rule: "auth-operation-unsupported",
						level: "error",
						field: `operations.${operationKey}`,
						message: `Provider "${provider.id ?? "unknown"}" operation "${operationKey}" looks like a login/token/session exchange endpoint. Authenticated providers must expose login through the single auth.flow interface because Gateway persists only auth.flow complete turn data.credential as the connection credential. Move this logic into auth.flow.continue instead of a provider operation.`,
					});
				}
			}
		}
	}

	if (!provider.operations) {
		return diagnostics;
	}

	diagnostics.push(
		...Object.entries(provider.operations).flatMap(
			([operationKey, operation]) =>
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

	return diagnostics;
}
