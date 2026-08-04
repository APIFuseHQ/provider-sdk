import { domainToASCII } from "node:url";

const STRICT_IPV4_PATTERN =
	/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const DECIMAL_COMPONENT_PATTERN = /^\d+$/;
const HEX_COMPONENT_PATTERN = /^0[xX][\da-fA-F]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const FORMAT_CONTROL_PATTERN = /\p{Cf}/u;
const RESERVED_EGRESS_HOST_DELIMITERS = ["/", "\\", "?", "#", "@", "[", "]", " ", "%"];

export type EgressHostCanonicalizationFailure =
	| "not-string"
	| "reserved-delimiter"
	| "control-character"
	| "whitespace"
	| "canonicalization-empty";

export type EgressHostCanonicalizationResult =
	| { readonly ok: true; readonly host: string }
	| { readonly ok: false; readonly reason: EgressHostCanonicalizationFailure };

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

export function classifyEgressTargetHost(host: string): "ipv4" | "numeric-ambiguous" | "dns" {
	if (parseStrictIpv4(host) !== undefined) return "ipv4";
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
	return CONTROL_CHARACTER_PATTERN.test(value) || FORMAT_CONTROL_PATTERN.test(value);
}

export function canonicalizeEgressHost(value: unknown): EgressHostCanonicalizationResult {
	if (typeof value !== "string") return { ok: false, reason: "not-string" };
	if (hasReservedEgressHostDelimiter(value)) return { ok: false, reason: "reserved-delimiter" };
	if (hasEgressHostControlCharacter(value)) return { ok: false, reason: "control-character" };
	if (/\s/u.test(value)) return { ok: false, reason: "whitespace" };
	const raw = value.trim();
	if (!raw) return { ok: false, reason: "canonicalization-empty" };

	// Classify the spelling with one optional root-label dot removed before IDNA.
	// This keeps resolver-numeric ASCII forms from being widened into canonical IPv4.
	const numericCandidate = raw.endsWith(".") ? raw.slice(0, -1) : raw;
	const normalizedNumericCandidate = numericCandidate.toLowerCase();
	if (classifyEgressTargetHost(normalizedNumericCandidate) === "numeric-ambiguous")
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

export function ipv4InCidr(address: number, cidr: string): boolean {
	const parsed = parseIpv4Cidr(cidr);
	if (!parsed.ok) return false;
	return (
		parsed.prefix === 0 ||
		address >>> (32 - parsed.prefix) === parsed.network >>> (32 - parsed.prefix)
	);
}
