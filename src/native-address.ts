import { domainToASCII } from "node:url";

const STRICT_IPV4_PATTERN =
	/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const DECIMAL_COMPONENT_PATTERN = /^\d+$/;
const HEX_COMPONENT_PATTERN = /^0[xX][\da-fA-F]+$/;
const IPV6_GROUP_PATTERN = /^[\da-fA-F]{1,4}$/;
const FORMAT_CONTROL_PATTERN = /\p{Cf}/u;
const RESERVED_EGRESS_HOST_DELIMITERS = ["/", "\\", "?", "#", "@", "[", "]", " ", "%"];

const IPV4_MAPPED_PREFIX = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff);
const IPV4_COMPATIBLE_MIN = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2);
const IPV4_COMPATIBLE_MAX = Uint8Array.of(
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0xff,
	0xff,
	0xff,
	0xff,
);

export type EgressHostKind = "ipv4" | "ipv6" | "ipv4-mapped-ipv6" | "numeric-ambiguous" | "dns";

export type EgressHostCanonicalizationFailure =
	| "not-string"
	| "reserved-delimiter"
	| "control-character"
	| "whitespace"
	| "canonicalization-empty";

export type EgressHostCanonicalizationResult =
	| { readonly ok: true; readonly host: string }
	| { readonly ok: false; readonly reason: EgressHostCanonicalizationFailure };

export type Ipv6CidrOverlap = "ipv4-mapped" | "ipv4-compatible";

export type Ipv6CidrParseResult =
	| { readonly ok: true; readonly network: Uint8Array; readonly prefix: number }
	| {
			readonly ok: false;
			readonly reason: "malformed";
			readonly overlap?: Ipv6CidrOverlap;
	  }
	| { readonly ok: false; readonly reason: "non-canonical-network" };

export function parseStrictIpv4(value: string): number | undefined {
	const match = STRICT_IPV4_PATTERN.exec(value);
	if (!match || match[0] !== value) return undefined;
	const [, first, second, third, fourth] = match;
	if (first === undefined || second === undefined || third === undefined || fourth === undefined)
		return undefined;
	const octets = [Number(first), Number(second), Number(third), Number(fourth)];
	if (octets.some((octet) => octet > 255)) return undefined;
	const [a, b, c, d] = octets;
	if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
	return (a * 0x1000000 + b * 0x10000 + c * 0x100 + d) >>> 0;
}

function ipv4HexGroups(value: string): readonly [string, string] | undefined {
	const address = parseStrictIpv4(value);
	if (address === undefined) return undefined;
	return [((address >>> 16) & 0xffff).toString(16), (address & 0xffff).toString(16)];
}

/** Parse the RFC 4291 IPv6 text forms accepted at both policy and runtime boundaries. */
export function parseIpv6(value: string): Uint8Array | undefined {
	if (!value || value.includes("%") || value.includes("[") || value.includes("]")) return undefined;
	if (value.indexOf("::") !== value.lastIndexOf("::")) return undefined;

	let text = value;
	if (text.includes(".")) {
		const finalColon = text.lastIndexOf(":");
		if (finalColon < 0) return undefined;
		const groups = ipv4HexGroups(text.slice(finalColon + 1));
		if (!groups) return undefined;
		text = `${text.slice(0, finalColon + 1)}${groups[0]}:${groups[1]}`;
	}

	const compression = text.indexOf("::");
	let groups: string[];
	if (compression >= 0) {
		const leftText = text.slice(0, compression);
		const rightText = text.slice(compression + 2);
		const left = leftText ? leftText.split(":") : [];
		const right = rightText ? rightText.split(":") : [];
		if (
			left.some((group) => !IPV6_GROUP_PATTERN.test(group)) ||
			right.some((group) => !IPV6_GROUP_PATTERN.test(group)) ||
			left.length + right.length >= 8
		)
			return undefined;
		groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
	} else {
		groups = text.split(":");
		if (groups.length !== 8 || groups.some((group) => !IPV6_GROUP_PATTERN.test(group)))
			return undefined;
	}

	const bytes = new Uint8Array(16);
	for (let index = 0; index < groups.length; index += 1) {
		const group = groups[index];
		if (group === undefined) return undefined;
		const parsed = Number.parseInt(group, 16);
		bytes[index * 2] = parsed >>> 8;
		bytes[index * 2 + 1] = parsed & 0xff;
	}
	return bytes;
}

function prefixMatches(address: Uint8Array, network: Uint8Array, prefix: number): boolean {
	const wholeBytes = Math.floor(prefix / 8);
	for (let index = 0; index < wholeBytes; index += 1) {
		if (address[index] !== network[index]) return false;
	}
	const remainingBits = prefix % 8;
	if (remainingBits === 0) return true;
	const mask = (0xff << (8 - remainingBits)) & 0xff;
	return ((address[wholeBytes] ?? 0) & mask) === ((network[wholeBytes] ?? 0) & mask);
}

function compareIpv6(left: Uint8Array, right: Uint8Array): number {
	for (let index = 0; index < 16; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function cidrMaximum(network: Uint8Array, prefix: number): Uint8Array {
	const maximum = network.slice();
	for (let bit = prefix; bit < 128; bit += 1) {
		const byteIndex = Math.floor(bit / 8);
		maximum[byteIndex] = (maximum[byteIndex] ?? 0) | (1 << (7 - (bit % 8)));
	}
	return maximum;
}

function rangesOverlap(
	leftMin: Uint8Array,
	leftMax: Uint8Array,
	rightMin: Uint8Array,
	rightMax: Uint8Array,
): boolean {
	return compareIpv6(leftMin, rightMax) <= 0 && compareIpv6(rightMin, leftMax) <= 0;
}

function ipv6CidrOverlap(network: Uint8Array, prefix: number): Ipv6CidrOverlap | undefined {
	const maximum = cidrMaximum(network, prefix);
	const mappedMin = new Uint8Array(16);
	mappedMin.set(IPV4_MAPPED_PREFIX);
	const mappedMax = mappedMin.slice();
	mappedMax.fill(0xff, 12);
	if (rangesOverlap(network, maximum, mappedMin, mappedMax)) return "ipv4-mapped";
	if (rangesOverlap(network, maximum, IPV4_COMPATIBLE_MIN, IPV4_COMPATIBLE_MAX))
		return "ipv4-compatible";
	return undefined;
}

export function parseIpv4Cidr(
	value: string,
):
	| { readonly ok: true; readonly network: number; readonly prefix: number }
	| { readonly ok: false; readonly reason: "malformed" | "non-canonical-network" } {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator !== value.lastIndexOf("/"))
		return { ok: false, reason: "malformed" };
	const address = parseStrictIpv4(value.slice(0, separator));
	const prefixText = value.slice(separator + 1);
	const prefix = Number(prefixText);
	if (
		address === undefined ||
		!Number.isInteger(prefix) ||
		prefix < 0 ||
		prefix > 32 ||
		String(prefix) !== prefixText
	)
		return { ok: false, reason: "malformed" };
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	const network = (address & mask) >>> 0;
	if (address !== network) return { ok: false, reason: "non-canonical-network" };
	return { ok: true, network, prefix };
}

export function parseIpv6Cidr(value: string): Ipv6CidrParseResult {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator !== value.lastIndexOf("/"))
		return { ok: false, reason: "malformed" };
	const address = parseIpv6(value.slice(0, separator));
	const prefixText = value.slice(separator + 1);
	const prefix = Number(prefixText);
	if (
		address === undefined ||
		!Number.isInteger(prefix) ||
		prefix < 0 ||
		prefix > 128 ||
		String(prefix) !== prefixText
	)
		return { ok: false, reason: "malformed" };
	const network = address.slice();
	const wholeBytes = Math.floor(prefix / 8);
	const remainingBits = prefix % 8;
	if (remainingBits > 0) {
		const mask = (0xff << (8 - remainingBits)) & 0xff;
		network[wholeBytes] = (network[wholeBytes] ?? 0) & mask;
	}
	network.fill(0, wholeBytes + (remainingBits > 0 ? 1 : 0));
	if (compareIpv6(address, network) !== 0) return { ok: false, reason: "non-canonical-network" };
	const overlap = ipv6CidrOverlap(network, prefix);
	if (overlap) return { ok: false, reason: "malformed", overlap };
	return { ok: true, network, prefix };
}

export function ipv4InCidr(address: number, cidr: string): boolean {
	const parsed = parseIpv4Cidr(cidr);
	if (!parsed.ok) return false;
	return (
		parsed.prefix === 0 ||
		address >>> (32 - parsed.prefix) === parsed.network >>> (32 - parsed.prefix)
	);
}

export function ipv6InCidr(address: Uint8Array, cidr: string): boolean {
	if (address.length !== 16) return false;
	const parsed = parseIpv6Cidr(cidr);
	return parsed.ok && prefixMatches(address, parsed.network, parsed.prefix);
}

export function embeddedIpv4FromIpv6(address: Uint8Array): number | undefined {
	if (address.length !== 16) return undefined;
	const mapped = IPV4_MAPPED_PREFIX.every((byte, index) => address[index] === byte);
	const compatible = address.slice(0, 12).every((byte) => byte === 0);
	const embedded =
		((address[12] ?? 0) * 0x1000000 +
			(address[13] ?? 0) * 0x10000 +
			(address[14] ?? 0) * 0x100 +
			(address[15] ?? 0)) >>>
		0;
	if (mapped || (compatible && embedded !== 0 && embedded !== 1)) return embedded;
	return undefined;
}

export function formatIpv6(address: Uint8Array): string {
	if (address.length !== 16) throw new TypeError("IPv6 addresses must contain exactly 16 bytes");
	const groups = Array.from({ length: 8 }, (_, index) =>
		(((address[index * 2] ?? 0) << 8) | (address[index * 2 + 1] ?? 0)).toString(16),
	);
	let bestStart = -1;
	let bestLength = 0;
	for (let index = 0; index < groups.length; ) {
		if (groups[index] !== "0") {
			index += 1;
			continue;
		}
		let end = index + 1;
		while (end < groups.length && groups[end] === "0") end += 1;
		if (end - index > bestLength && end - index >= 2) {
			bestStart = index;
			bestLength = end - index;
		}
		index = end;
	}
	if (bestStart < 0) return groups.join(":");
	const left = groups.slice(0, bestStart).join(":");
	const right = groups.slice(bestStart + bestLength).join(":");
	return `${left}::${right}`;
}

/** The single family and ambiguity classifier used by policy and runtime matching. */
export function classifyEgressHost(host: string): EgressHostKind {
	if (
		hasReservedEgressHostDelimiter(host) ||
		hasEgressHostControlCharacter(host) ||
		/\s/u.test(host)
	)
		return "numeric-ambiguous";
	if (parseStrictIpv4(host) !== undefined) return "ipv4";
	const ipv6 = parseIpv6(host);
	if (ipv6) return embeddedIpv4FromIpv6(ipv6) === undefined ? "ipv6" : "ipv4-mapped-ipv6";
	if (host.includes(":")) return "numeric-ambiguous";
	const labels = host.split(".");
	if (
		labels.every(
			(label) =>
				DECIMAL_COMPONENT_PATTERN.exec(label)?.[0] === label ||
				HEX_COMPONENT_PATTERN.exec(label)?.[0] === label,
		)
	)
		return "numeric-ambiguous";
	return "dns";
}

export function hasReservedEgressHostDelimiter(value: string): boolean {
	return RESERVED_EGRESS_HOST_DELIMITERS.some((delimiter) => value.includes(delimiter));
}

export function hasEgressHostControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return FORMAT_CONTROL_PATTERN.test(value);
}

export function canonicalizeEgressHost(value: unknown): EgressHostCanonicalizationResult {
	if (typeof value !== "string") return { ok: false, reason: "not-string" };
	if (hasReservedEgressHostDelimiter(value)) return { ok: false, reason: "reserved-delimiter" };
	if (hasEgressHostControlCharacter(value)) return { ok: false, reason: "control-character" };
	if (/\s/u.test(value)) return { ok: false, reason: "whitespace" };
	const raw = value.trim();
	if (!raw) return { ok: false, reason: "canonicalization-empty" };

	const ipv6 = parseIpv6(raw);
	if (ipv6) return { ok: true, host: formatIpv6(ipv6) };

	// Classify the spelling with one optional root-label dot removed before IDNA.
	// This keeps resolver-numeric ASCII forms from being widened into canonical IPv4.
	const numericCandidate = raw.endsWith(".") ? raw.slice(0, -1) : raw;
	const normalizedNumericCandidate = numericCandidate.toLowerCase();
	if (classifyEgressHost(normalizedNumericCandidate) === "numeric-ambiguous")
		return { ok: true, host: normalizedNumericCandidate };

	let ascii: string;
	try {
		ascii = domainToASCII(raw).toLowerCase().replace(/\.$/, "");
	} catch {
		return { ok: false, reason: "canonicalization-empty" };
	}
	if (!ascii || /^\.+$/.test(ascii)) return { ok: false, reason: "canonicalization-empty" };
	return { ok: true, host: ascii };
}
