const STRICT_IPV4_PATTERN =
	/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;
const DECIMAL_COMPONENT_PATTERN = /^\d+$/;
const HEX_COMPONENT_PATTERN = /^0[xX][\da-fA-F]+$/;

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

export function parseIpv4Cidr(
	value: string,
): { readonly network: number; readonly prefix: number } | undefined {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator !== value.lastIndexOf("/")) return undefined;
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
		return undefined;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	const network = (address & mask) >>> 0;
	if (address !== network) return undefined;
	return { network, prefix };
}

export function ipv4InCidr(address: number, cidr: string): boolean {
	const parsed = parseIpv4Cidr(cidr);
	if (!parsed) return false;
	return (
		parsed.prefix === 0 ||
		address >>> (32 - parsed.prefix) === parsed.network >>> (32 - parsed.prefix)
	);
}
