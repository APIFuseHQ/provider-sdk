import { ProviderSecretError } from "../errors.js";
import type { EnvContext, ProviderDefinition } from "../types.js";

/**
 * Canonical error code for a declared-but-unprovisioned provider secret.
 *
 * The SDK is the single source of truth for env/secret presence validation:
 * providers declare secrets in `defineProvider({ secrets: [...] })` and the
 * runtime enforces presence before any handler or auth-flow code runs.
 * Provider-local presence guards (requireServiceKey/requireApiKey style) are a
 * deprecated antipattern — see the `sdk-owned-secret-presence` submit-check
 * rule.
 */
export const MISSING_SECRET_CODE = "MISSING_SECRET";

/**
 * Names of declared `required: true` secrets whose env values are unset or
 * whitespace-only. Whitespace-only values count as missing for parity with the
 * `.trim()` guards well-built providers used before the SDK owned this check —
 * a blank value provisioned by a broken secret pipeline must not pass the gate.
 */
export function listMissingRequiredSecrets(
	provider: ProviderDefinition,
	env: EnvContext,
): string[] {
	const missing: string[] = [];
	for (const secret of provider.secrets ?? []) {
		if (secret.required !== true) {
			continue;
		}
		const value = env.get(secret.name);
		if (value === undefined || value.trim() === "") {
			missing.push(secret.name);
		}
	}
	return missing;
}

/**
 * Throws the canonical structured missing-secret error when any declared
 * `required: true` secret is absent. All missing names are reported in a
 * single error so operators can provision the full set in one pass instead of
 * discovering them one deploy at a time (the 2026-07-22 unprovisioned-secret
 * incident failure mode).
 */
export function assertRequiredSecretsPresent(
	provider: ProviderDefinition,
	env: EnvContext,
): void {
	const missing = listMissingRequiredSecrets(provider, env);
	if (missing.length === 0) {
		return;
	}
	const names = missing.join(", ");
	throw new ProviderSecretError(
		`Missing required provider secret${missing.length > 1 ? "s" : ""}: ${names}`,
		{
			code: MISSING_SECRET_CODE,
			category: "credential_unavailable",
			retryable: false,
			fix: `Provision ${names} in the provider environment (e.g. Doppler). Declared in defineProvider({ secrets: [...] }).`,
		},
	);
}
