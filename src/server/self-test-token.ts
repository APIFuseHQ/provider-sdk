import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shared master secret injected into every provider pod. The per-provider
 * bearer token is derived from it, so compromise of one pod's env cannot
 * unlock another provider's self-test endpoint.
 */
export const PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_ENV =
	"APIFUSE__PROVIDER_RUNTIME__SELF_TEST_MASTER_SECRET";

/**
 * Previous master secret accepted during a rotation window so fleet-wide
 * rotation does not need to be atomic.
 */
export const PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_PREVIOUS_ENV =
	"APIFUSE__PROVIDER_RUNTIME__SELF_TEST_MASTER_SECRET_PREVIOUS";

/** Internal self-test listener port (never the tenant-facing serve() port). */
export const PROVIDER_RUNTIME_SELF_TEST_PORT_ENV = "APIFUSE__PROVIDER_RUNTIME__SELF_TEST_PORT";

export const DEFAULT_SELF_TEST_PORT = 3001;

export interface SelfTestMasterSecrets {
	readonly current: string;
	readonly previous?: string;
}

/**
 * Per-provider self-test bearer token: HMAC-SHA256(masterSecret, providerId),
 * hex-encoded. Computed identically by the provider pod and the scheduler.
 */
export function deriveSelfTestToken(masterSecret: string, providerId: string): string {
	return createHmac("sha256", masterSecret).update(providerId).digest("hex");
}

export function resolveSelfTestMasterSecrets(
	env: Readonly<Record<string, string | undefined>> = process.env,
): SelfTestMasterSecrets | undefined {
	const current = env[PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_ENV]?.trim();
	if (!current) return undefined;
	const previous = env[PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_PREVIOUS_ENV]?.trim();
	return previous ? { current, previous } : { current };
}

function digestsMatch(presented: string, expected: string): boolean {
	// Hash both sides before comparison so timingSafeEqual sees equal-length
	// buffers regardless of what the caller presented (constant-time path).
	const presentedDigest = createHash("sha256").update(presented).digest();
	const expectedDigest = createHash("sha256").update(expected).digest();
	return timingSafeEqual(presentedDigest, expectedDigest);
}

/**
 * Verifies an Authorization header against the current-or-previous derived
 * token (dual acceptance for one rotation window). Constant-time comparison;
 * returns only a boolean so callers cannot leak which check failed.
 */
export function verifySelfTestAuthorization(
	authorizationHeader: string | undefined,
	providerId: string,
	secrets: SelfTestMasterSecrets,
): boolean {
	const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? "");
	const presented = match?.[1] ?? "";
	const currentOk = digestsMatch(presented, deriveSelfTestToken(secrets.current, providerId));
	const previousOk = secrets.previous
		? digestsMatch(presented, deriveSelfTestToken(secrets.previous, providerId))
		: false;
	return currentOk || previousOk;
}
