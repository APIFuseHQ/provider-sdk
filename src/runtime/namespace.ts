import { createHmac } from "node:crypto";

import { deriveSubkey } from "./key-derivation";

const HMAC_HEX_LENGTH = 16;

/**
 * @internal Trusted loaders only; not re-exported to provider-importable paths.
 *
 * Returns `provider:{HMAC16(contextNamespaceSubkey, providerId)}:{sessionId}`
 * per the `context-namespace` HKDF purpose. Knowing `providerId` alone is
 * insufficient to reconstruct the namespace — the HMAC requires the derived
 * subkey, which is never exposed outside trusted code.
 */
export function deriveContextNamespace(
	masterSecret: Buffer,
	providerId: string,
	sessionId: string,
	keyVersion: number,
): string {
	if (sessionId.length === 0) {
		throw new Error("sessionId is empty");
	}

	const subkey = deriveSubkey(
		masterSecret,
		providerId,
		"context-namespace",
		keyVersion,
	);
	const hmac = createHmac("sha256", subkey).update(providerId).digest("hex");
	return `provider:${hmac.slice(0, HMAC_HEX_LENGTH)}:${sessionId}`;
}
