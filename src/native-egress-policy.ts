import type {
	NativeProviderConfig,
	NativeTcpDynamicEgressRule,
	NativeTcpEgressRule,
	NativeTcpPortRange,
	NativeTcpTlsMode,
} from "./types.js";
import {
	canonicalizeEgressHost,
	formatIpv6,
	parseIpv4Cidr,
	parseIpv6Cidr,
} from "./native-address.js";

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
	sourceIpv4Cidrs: true,
	sourceIpv6Cidrs: true,
	sourcePorts: true,
	sourcePortRanges: true,
	targetHostSuffixes: true,
	targetIpv4Cidrs: true,
	targetIpv6Cidrs: true,
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
	readonly sourceIpv4Cidrs: readonly string[];
	readonly sourceIpv6Cidrs: readonly string[];
	readonly sourcePorts: readonly number[];
	readonly sourcePortRanges: readonly NativeTcpPortRange[];
	readonly targetHostSuffixes: readonly string[];
	readonly targetIpv4Cidrs: readonly string[];
	readonly targetIpv6Cidrs: readonly string[];
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

function host(value: unknown, fieldPath: string, suffix = false): string {
	if (typeof value === "string" && value.includes("*"))
		fail(`${fieldPath} must be an exact ${suffix ? "DNS suffix" : "hostname"}, not a wildcard`);
	const canonical = canonicalizeEgressHost(value);
	if (!canonical.ok) fail(`${fieldPath} must be a non-empty hostname`);
	return canonical.host;
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

function ipv4Cidrs(value: unknown, fieldPath: string): readonly string[] {
	const seen = new Set<string>();
	return dataArray(value, fieldPath).map((value, index) => {
		const cidrPath = `${fieldPath}[${index}]`;
		if (typeof value !== "string") fail(`${cidrPath} must be an IPv4 CIDR in a.b.c.d/nn form`);
		const parsed = parseIpv4Cidr(value);
		if (!parsed.ok) {
			if (parsed.reason === "non-canonical-network")
				fail(`${cidrPath} must use the canonical network address with no host bits set`);
			fail(`${cidrPath} must be an IPv4 CIDR in a.b.c.d/nn form`);
		}
		const duplicateKey = `${parsed.network}/${parsed.prefix}`;
		if (seen.has(duplicateKey)) fail(`${fieldPath} must not contain duplicate CIDRs`);
		seen.add(duplicateKey);
		return value;
	});
}

function ipv6Cidrs(value: unknown, fieldPath: string): readonly string[] {
	const seen = new Set<string>();
	return dataArray(value, fieldPath).map((value, index) => {
		const cidrPath = `${fieldPath}[${index}]`;
		if (typeof value !== "string") fail(`${cidrPath} must be an IPv6 CIDR in address/nn form`);
		const parsed = parseIpv6Cidr(value);
		if (!parsed.ok) {
			if (parsed.reason === "non-canonical-network")
				fail(`${cidrPath} must use the canonical network address with no host bits set`);
			if (parsed.overlap === "ipv4-mapped")
				fail(`${cidrPath} overlaps IPv4-mapped ::ffff:0:0/96 address space`);
			if (parsed.overlap === "ipv4-compatible")
				fail(`${cidrPath} overlaps IPv4-compatible ::/96 address space`);
			fail(`${cidrPath} must be an IPv6 CIDR in address/nn form`);
		}
		const duplicateKey = `${formatIpv6(parsed.network)}/${parsed.prefix}`;
		if (seen.has(duplicateKey)) fail(`${fieldPath} must not contain duplicate CIDRs`);
		seen.add(duplicateKey);
		return value;
	});
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
						const sourceIpv4Cidrs =
							rule.sourceIpv4Cidrs === undefined
								? []
								: ipv4Cidrs(rule.sourceIpv4Cidrs, `${fieldPath}.sourceIpv4Cidrs`);
						const sourceIpv6Cidrs =
							rule.sourceIpv6Cidrs === undefined
								? []
								: ipv6Cidrs(rule.sourceIpv6Cidrs, `${fieldPath}.sourceIpv6Cidrs`);
						if (
							sourceHost === undefined &&
							sourceHostSuffixes.length === 0 &&
							sourceIpv4Cidrs.length === 0 &&
							sourceIpv6Cidrs.length === 0
						)
							fail(
								`${fieldPath} must declare sourceHost or a non-empty sourceHostSuffixes, sourceIpv4Cidrs, or sourceIpv6Cidrs list`,
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
							fail(`${fieldPath} must declare a non-empty sourcePorts or sourcePortRanges list`);
						const targetHostSuffixes =
							rule.targetHostSuffixes === undefined
								? []
								: hostSuffixes(rule.targetHostSuffixes, `${fieldPath}.targetHostSuffixes`);
						const targetIpv4Cidrs =
							rule.targetIpv4Cidrs === undefined
								? []
								: ipv4Cidrs(rule.targetIpv4Cidrs, `${fieldPath}.targetIpv4Cidrs`);
						const targetIpv6Cidrs =
							rule.targetIpv6Cidrs === undefined
								? []
								: ipv6Cidrs(rule.targetIpv6Cidrs, `${fieldPath}.targetIpv6Cidrs`);
						if (
							targetHostSuffixes.length === 0 &&
							targetIpv4Cidrs.length === 0 &&
							targetIpv6Cidrs.length === 0
						)
							fail(
								`${fieldPath} must declare a non-empty targetHostSuffixes, targetIpv4Cidrs, or targetIpv6Cidrs list`,
							);
						const targetPorts =
							rule.targetPorts === undefined
								? []
								: ports(rule.targetPorts, `${fieldPath}.targetPorts`);
						const targetPortRanges =
							rule.targetPortRanges === undefined
								? []
								: ranges(rule.targetPortRanges, `${fieldPath}.targetPortRanges`);
						if (targetPorts.length === 0 && targetPortRanges.length === 0)
							fail(`${fieldPath} must declare a non-empty targetPorts or targetPortRanges list`);
						return {
							...(sourceHost === undefined ? {} : { sourceHost }),
							sourceHostSuffixes,
							sourceIpv4Cidrs,
							sourceIpv6Cidrs,
							sourcePorts,
							sourcePortRanges,
							targetHostSuffixes,
							targetIpv4Cidrs,
							targetIpv6Cidrs,
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
