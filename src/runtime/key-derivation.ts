import { createHash, hkdfSync } from "node:crypto";

/**
 * HKDF purpose enum. Closed set; adding a purpose requires a spec amendment in
 * `provider-isolation-hardening`. Each purpose uses a distinct salt so a leak
 * of one subkey cannot reveal another for the same provider.
 *
 * Tenant-scoped columns (`connections.external_ref`, `connections.metadata`)
 * are plaintext with RLS + log redaction + audit log; no HKDF purpose exists
 * for them.
 */
export type KeyPurpose =
	| "credential-encryption"
	| "context-namespace"
	| "token-signing";

const SALT_PREFIX = "apifuse:v1:";
const OUTPUT_LENGTH = 32;

const cache = new Map<string, Buffer>();

function cacheKey(
	keyVersion: number,
	providerId: string,
	purpose: KeyPurpose,
): string {
	return `${keyVersion}\u0000${providerId}\u0000${purpose}`;
}

function computeSalt(purpose: KeyPurpose): Buffer {
	return createHash("sha256")
		.update(SALT_PREFIX + purpose)
		.digest();
}

function computeInfo(providerId: string): Buffer {
	return Buffer.from(`provider=${providerId}`, "utf8");
}

/** @internal Trusted loaders only; not re-exported to provider-importable paths. */
export function decodeMasterKey(encoded: string): Buffer {
	if (typeof encoded !== "string" || encoded.length === 0) {
		throw new ConfigurationError(
			"master key is empty; set APIFUSE__KEYRING__MASTER_KEY_V{n} in the external secret manager",
		);
	}

	const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
	const padded =
		normalized.length % 4 === 0
			? normalized
			: normalized + "=".repeat(4 - (normalized.length % 4));

	// Pre-decode character set guard — Buffer.from silently accepts invalid base64.
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) {
		throw new ConfigurationError("master key is not valid base64");
	}

	const raw = Buffer.from(padded, "base64");

	// Invalid base64 truncates silently; compare against the expected decode length.
	const expectedMinLength = Math.floor((padded.length * 3) / 4) - 2;
	if (raw.length < expectedMinLength) {
		throw new ConfigurationError("master key is not valid base64");
	}

	if (raw.length < 32) {
		throw new ConfigurationError(
			`master key must be ≥ 32 bytes after base64 decode (got ${raw.length})`,
		);
	}

	return raw;
}

export class ConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigurationError";
	}
}

/** @internal Trusted loaders only; not re-exported to provider-importable paths. */
export function deriveSubkey(
	masterSecret: Buffer,
	providerId: string,
	purpose: KeyPurpose,
	keyVersion: number,
): Buffer {
	if (masterSecret.length < 32) {
		throw new ConfigurationError(
			`master key must be ≥ 32 bytes (got ${masterSecret.length})`,
		);
	}
	if (providerId.length === 0) {
		throw new ConfigurationError("providerId is empty");
	}

	const key = cacheKey(keyVersion, providerId, purpose);
	const cached = cache.get(key);
	if (cached) {
		return cached;
	}

	const salt = computeSalt(purpose);
	const info = computeInfo(providerId);
	const subkey = Buffer.from(
		hkdfSync("sha256", masterSecret, salt, info, OUTPUT_LENGTH),
	);
	cache.set(key, subkey);
	return subkey;
}

/**
 * Invalidate the subkey cache. Used by the master-key rotation worker after a
 * writer version change, and by tests to assert determinism.
 *
 * @internal
 */
export function invalidateSubkeyCache(): void {
	cache.clear();
}
