declare const SESSION_KEY_BRAND: unique symbol;

/** Canonical, opaque identity for a stateful provider session. */
export type SessionKey = string & { readonly [SESSION_KEY_BRAND]: "SessionKey" };

export interface SessionKeyParts {
	readonly providerId: string;
	readonly serviceAccountId: string;
	readonly connectionId: string;
	/** Optional extra session axes (e.g. device, mailbox, persona). Defaults to none. */
	readonly dimensions?: Readonly<Record<string, string>>;
}

const PREFIX = "stateful:v1";
const REQUIRED_DIMENSIONS = ["providerId", "serviceAccountId", "connectionId"] as const;
const REQUIRED_DIMENSION_SET = new Set<string>(REQUIRED_DIMENSIONS);

export function buildSessionKey(parts: SessionKeyParts): SessionKey {
	validateRequiredPart(parts.providerId, "providerId");
	validateRequiredPart(parts.serviceAccountId, "serviceAccountId");
	validateRequiredPart(parts.connectionId, "connectionId");

	const dimensions = Object.entries(parts.dimensions ?? {}).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	for (const [name, value] of dimensions) {
		validateDimension(name, value);
	}

	const segments: Array<readonly [string, string]> = [
		["providerId", parts.providerId],
		["serviceAccountId", parts.serviceAccountId],
		["connectionId", parts.connectionId],
		...dimensions,
	];
	return `${PREFIX}/${segments
		.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
		.join("/")}` as SessionKey;
}

export function parseSessionKey(key: string): SessionKeyParts {
	const prefix = `${PREFIX}/`;
	if (!key.startsWith(prefix)) {
		throw new Error(`Invalid session key: expected canonical prefix "${PREFIX}".`);
	}

	const parsed = new Map<string, string>();
	for (const segment of key.slice(prefix.length).split("/")) {
		const separator = segment.indexOf("=");
		if (separator <= 0) {
			throw new Error(`Invalid session key segment "${segment}"; expected name=value.`);
		}
		const name = decodeSegment(segment.slice(0, separator), "dimension name");
		const value = decodeSegment(segment.slice(separator + 1), `dimension "${name}"`);
		if (parsed.has(name)) {
			throw new Error(`Invalid session key: duplicate dimension "${name}".`);
		}
		if (name.trim().length === 0) {
			throw new Error("Invalid session key: dimension name must not be empty.");
		}
		if (value.trim().length === 0) {
			throw new Error(`Invalid session key: dimension "${name}" must not be empty.`);
		}
		parsed.set(name, value);
	}

	for (const required of REQUIRED_DIMENSIONS) {
		if (!parsed.has(required)) {
			throw new Error(`Invalid session key: missing required dimension "${required}".`);
		}
	}

	const dimensions: Record<string, string> = {};
	for (const [name, value] of parsed) {
		if (!REQUIRED_DIMENSION_SET.has(name)) dimensions[name] = value;
	}
	return {
		providerId: parsed.get("providerId") as string,
		serviceAccountId: parsed.get("serviceAccountId") as string,
		connectionId: parsed.get("connectionId") as string,
		dimensions,
	};
}

function validateRequiredPart(value: string, name: string): void {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Cannot build session key: required dimension "${name}" is missing or empty.`);
	}
}

function validateDimension(name: string, value: string): void {
	if (name.trim().length === 0) {
		throw new Error("Cannot build session key: extra dimension name must not be empty.");
	}
	if (REQUIRED_DIMENSION_SET.has(name)) {
		throw new Error(
			`Cannot build session key: extra dimension "${name}" duplicates a required dimension.`,
		);
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Cannot build session key: extra dimension "${name}" is missing or empty.`);
	}
}

function decodeSegment(value: string, label: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new Error(`Invalid session key: ${label} is not valid URI encoding.`);
	}
}
