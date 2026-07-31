import type {
	NativeProviderConfig,
	NativeTcpDynamicEgressRule,
	NativeTcpEgressRule,
	NativeTcpPortRange,
	NativeTcpTlsMode,
} from "./types.js";

type NativeNetworkDeclaration = NonNullable<NativeProviderConfig["network"]>;

const NATIVE_PROVIDER_FIELD_RECORD = {
	network: true,
} satisfies { readonly [K in keyof Required<NativeProviderConfig>]: true };
const NATIVE_NETWORK_FIELD_RECORD = {
	tcp: true,
	dynamicTcp: true,
} satisfies { readonly [K in keyof Required<NativeNetworkDeclaration>]: true };
const NATIVE_TCP_RULE_FIELD_RECORD = {
	host: true,
	ports: true,
	tls: true,
} satisfies { readonly [K in keyof Required<NativeTcpEgressRule>]: true };
const NATIVE_DYNAMIC_TCP_RULE_FIELD_RECORD = {
	sourceHost: true,
	sourceHostSuffixes: true,
	sourcePorts: true,
	sourcePortRanges: true,
	targetHostSuffixes: true,
	targetPorts: true,
	targetPortRanges: true,
	tls: true,
	ttlMs: true,
	maxGrants: true,
} satisfies { readonly [K in keyof Required<NativeTcpDynamicEgressRule>]: true };
const NATIVE_TCP_PORT_RANGE_FIELD_RECORD = {
	start: true,
	end: true,
} satisfies { readonly [K in keyof Required<NativeTcpPortRange>]: true };

const NATIVE_PROVIDER_FIELDS = Object.keys(NATIVE_PROVIDER_FIELD_RECORD);
const NATIVE_NETWORK_FIELDS = Object.keys(NATIVE_NETWORK_FIELD_RECORD);
const NATIVE_TCP_RULE_FIELDS = Object.keys(NATIVE_TCP_RULE_FIELD_RECORD);
const NATIVE_DYNAMIC_TCP_RULE_FIELDS = Object.keys(NATIVE_DYNAMIC_TCP_RULE_FIELD_RECORD);
const NATIVE_TCP_PORT_RANGE_FIELDS = Object.keys(NATIVE_TCP_PORT_RANGE_FIELD_RECORD);

export type StaticEgressRuleSnapshot = {
	readonly host: string;
	readonly ports: readonly number[];
	readonly tls: NativeTcpTlsMode;
};

export type DynamicEgressRuleSnapshot = {
	readonly sourceHost?: string;
	readonly sourceHostSuffixes: readonly string[];
	readonly sourcePorts: readonly number[];
	readonly sourcePortRanges: readonly NativeTcpPortRange[];
	readonly targetHostSuffixes: readonly string[];
	readonly targetPorts: readonly number[];
	readonly targetPortRanges: readonly NativeTcpPortRange[];
	readonly tls: NativeTcpTlsMode;
	readonly ttlMs?: number;
	readonly maxGrants?: number;
};

export type NativeEgressPolicySnapshot = {
	readonly staticRules: readonly StaticEgressRuleSnapshot[];
	readonly dynamicRules: readonly DynamicEgressRuleSnapshot[];
};

export class NativeEgressPolicyValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NativeEgressPolicyValidationError";
	}
}

function fail(message: string): never {
	throw new NativeEgressPolicyValidationError(message);
}

function dataRecord(
	value: unknown,
	fieldPath: string,
	allowed: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(`${fieldPath} must be an object`);
	const prototype = Reflect.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		fail(`${fieldPath} must be a plain object`);
	const record: Record<string, unknown> = {};
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") fail(`${fieldPath} must not contain symbol fields`);
		if (!allowed.includes(key)) fail(`Unknown field ${fieldPath}.${key}`);
		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) fail(`${fieldPath}.${key} must be a data field`);
		record[key] = descriptor.value;
	}
	return record;
}

function dataArray(value: unknown, fieldPath: string): readonly unknown[] {
	if (!Array.isArray(value)) fail(`${fieldPath} must be an array`);
	const result: unknown[] = [];
	for (const key of Reflect.ownKeys(value)) {
		if (key === "length") continue;
		if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key))
			fail(`${fieldPath} must not contain non-index fields`);
		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) fail(`${fieldPath}[${key}] must be a data field`);
		result[Number(key)] = descriptor.value;
	}
	if (result.length !== value.length) fail(`${fieldPath} must not be sparse`);
	for (let index = 0; index < result.length; index += 1) {
		if (!(index in result)) fail(`${fieldPath} must not be sparse`);
	}
	return result;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function host(value: unknown, fieldPath: string, suffix = false): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		hasControlCharacter(value) ||
		/\s/.test(value) ||
		value.includes("://")
	)
		fail(`${fieldPath} must be a non-empty hostname`);
	if (value.includes("*"))
		fail(`${fieldPath} must be an exact ${suffix ? "DNS suffix" : "hostname"}, not a wildcard`);
	const normalized = value.trim().toLowerCase().replace(/\.$/, "");
	if (!normalized) fail(`${fieldPath} must be a non-empty hostname`);
	return normalized;
}

function port(value: unknown, fieldPath: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65_535)
		fail(`${fieldPath} must be an integer from 1 to 65535`);
	return value;
}

function ports(value: unknown, fieldPath: string): readonly number[] {
	return dataArray(value, fieldPath).map((value, index) => port(value, `${fieldPath}[${index}]`));
}

function hostSuffixes(value: unknown, fieldPath: string): readonly string[] {
	return dataArray(value, fieldPath).map((value, index) =>
		host(value, `${fieldPath}[${index}]`, true),
	);
}

function ranges(value: unknown, fieldPath: string): readonly NativeTcpPortRange[] {
	return dataArray(value, fieldPath).map((value, index) => {
		const rangePath = `${fieldPath}[${index}]`;
		const record = dataRecord(value, rangePath, NATIVE_TCP_PORT_RANGE_FIELDS);
		const start = port(record.start, `${rangePath}.start`);
		const end = port(record.end, `${rangePath}.end`);
		if (start > end) fail(`${rangePath}.start must not exceed end`);
		return { start, end };
	});
}

function tls(value: unknown, fieldPath: string): NativeTcpTlsMode {
	if (value !== "required" && value !== "allowed" && value !== "disabled")
		fail(`${fieldPath} must be required, allowed, or disabled`);
	return value;
}

function positiveInteger(value: unknown, fieldPath: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		fail(`${fieldPath} must be a positive integer`);
	return value;
}

export function parseNativeEgressPolicy(value: unknown): NativeEgressPolicySnapshot {
	try {
		const policy = dataRecord(value, "native.network", NATIVE_NETWORK_FIELDS);
		const staticRules =
			policy.tcp === undefined
				? []
				: dataArray(policy.tcp, "native.network.tcp").map((value, index) => {
						const fieldPath = `native.network.tcp[${index}]`;
						const rule = dataRecord(value, fieldPath, NATIVE_TCP_RULE_FIELDS);
						const declaredPorts = ports(rule.ports, `${fieldPath}.ports`);
						if (declaredPorts.length === 0) fail(`${fieldPath}.ports must not be empty`);
						return {
							host: host(rule.host, `${fieldPath}.host`),
							ports: declaredPorts,
							tls: tls(rule.tls, `${fieldPath}.tls`),
						};
					});
		const dynamicRules =
			policy.dynamicTcp === undefined
				? []
				: dataArray(policy.dynamicTcp, "native.network.dynamicTcp").map((value, index) => {
						const fieldPath = `native.network.dynamicTcp[${index}]`;
						const rule = dataRecord(value, fieldPath, NATIVE_DYNAMIC_TCP_RULE_FIELDS);
						const sourceHost =
							rule.sourceHost === undefined
								? undefined
								: host(rule.sourceHost, `${fieldPath}.sourceHost`);
						const sourceHostSuffixes =
							rule.sourceHostSuffixes === undefined
								? []
								: hostSuffixes(rule.sourceHostSuffixes, `${fieldPath}.sourceHostSuffixes`);
						if (sourceHost === undefined && sourceHostSuffixes.length === 0)
							fail(
								`${fieldPath} must declare sourceHost or a non-empty sourceHostSuffixes list`,
							);
						const sourcePorts =
							rule.sourcePorts === undefined
								? []
								: ports(rule.sourcePorts, `${fieldPath}.sourcePorts`);
						const sourcePortRanges =
							rule.sourcePortRanges === undefined
								? []
								: ranges(rule.sourcePortRanges, `${fieldPath}.sourcePortRanges`);
						if (sourcePorts.length === 0 && sourcePortRanges.length === 0)
							fail(
								`${fieldPath} must declare a non-empty sourcePorts or sourcePortRanges list`,
							);
						const targetHostSuffixes = hostSuffixes(
							rule.targetHostSuffixes,
							`${fieldPath}.targetHostSuffixes`,
						);
						if (targetHostSuffixes.length === 0)
							fail(`${fieldPath}.targetHostSuffixes must not be empty`);
						const targetPorts =
							rule.targetPorts === undefined
								? []
								: ports(rule.targetPorts, `${fieldPath}.targetPorts`);
						const targetPortRanges =
							rule.targetPortRanges === undefined
								? []
								: ranges(rule.targetPortRanges, `${fieldPath}.targetPortRanges`);
						if (targetPorts.length === 0 && targetPortRanges.length === 0)
							fail(
								`${fieldPath} must declare a non-empty targetPorts or targetPortRanges list`,
							);
						return {
							...(sourceHost === undefined ? {} : { sourceHost }),
							sourceHostSuffixes,
							sourcePorts,
							sourcePortRanges,
							targetHostSuffixes,
							targetPorts,
							targetPortRanges,
							tls: tls(rule.tls, `${fieldPath}.tls`),
							...(rule.ttlMs === undefined
								? {}
								: { ttlMs: positiveInteger(rule.ttlMs, `${fieldPath}.ttlMs`) }),
							...(rule.maxGrants === undefined
								? {}
								: { maxGrants: positiveInteger(rule.maxGrants, `${fieldPath}.maxGrants`) }),
						};
					});
		return { staticRules, dynamicRules };
	} catch (error) {
		if (error instanceof NativeEgressPolicyValidationError) throw error;
		throw new NativeEgressPolicyValidationError(
			"Native egress policy could not be inspected safely",
		);
	}
}

export function validateNativeProviderConfig(value: unknown): void {
	if (value === undefined) return;
	try {
		const native = dataRecord(value, "native", NATIVE_PROVIDER_FIELDS);
		if (native.network !== undefined) parseNativeEgressPolicy(native.network);
	} catch (error) {
		if (error instanceof NativeEgressPolicyValidationError) throw error;
		throw new NativeEgressPolicyValidationError(
			"Native provider config could not be inspected safely",
		);
	}
}
