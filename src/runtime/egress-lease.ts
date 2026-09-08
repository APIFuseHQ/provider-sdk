import { readDiagnosticEnv } from "./diagnostic-env.js";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { ProxyVendorName } from "../config/loader.js";
import { SDKError } from "../errors.js";

/**
 * AES-256-GCM key for the engine ceremony egress lease handle (ADR-0010 v1.1).
 * Engine host only: the `APIFUSE__ENGINE__` family is rejected from provider
 * secrets and filtered from provider env projections. Supply at least 32 random
 * bytes (for example `openssl rand -base64 32`). Rotating the key fails
 * verification of every outstanding handle (`EGRESS_LEASE_INVALID`, 409): the
 * affected ceremonies restart; they do not expire.
 */
export const APIFUSE__ENGINE__CEREMONY_LEASE_KEY = "APIFUSE__ENGINE__CEREMONY_LEASE_KEY";

/** Internal option key shared only by the server assembler and stealth runtime. */
export const ENGINE_CEREMONY_EGRESS_LEASE = Symbol.for(
	"@apifuse/provider-sdk/engine-ceremony-egress-lease",
);

const HANDLE_VERSION = 1;
const HANDLE_MAX_BYTES = 16_384;
const AEAD_NONCE_BYTES = 12;
const AEAD_TAG_BYTES = 16;
const AEAD_ALGORITHM = "aes-256-gcm";
const AEAD_KEY_DOMAIN = "apifuse:ceremony-egress-lease:v1\0";
const LEASE_KEY_MIN_BYTES = 32;

export type CeremonyEgressBinding = {
	readonly vendor: ProxyVendorName;
	readonly proxyUrl: string;
	readonly poolIndex: number;
	readonly affinityKey: string;
	readonly refreshEpoch: number;
	/**
	 * Vendor session lifetime the endpoint was allocated for (`proxy.session.lifetimeMinutes`,
	 * Smartproxy `life`, NodeMaven SID window). It is the upper bound of the lease, counted
	 * from the mint (the first successful attempt), so a Smartproxy lease can outlive the
	 * vendor session by the extraction-cache reuse window; expiry then drops and rebinds.
	 * The bound is not a vendor guarantee (ADR-0010: a raw Smartproxy endpoint is not a hard
	 * lease): the stealth runtime releases the binding as soon as the endpoint fails at the
	 * transport, so a dead endpoint is left before the lifetime elapses.
	 */
	readonly lifetimeMinutes: number;
};

type CeremonyEgressLeasePayloadV1 = CeremonyEgressBinding & {
	readonly version: typeof HANDLE_VERSION;
	readonly tenantId: string;
	readonly providerId: string;
	readonly flowId: string;
	readonly mintedAtMs: number;
	readonly expiresAtMs: number;
};

type CeremonyEgressLeaseScopeV1 = Pick<
	CeremonyEgressLeasePayloadV1,
	"tenantId" | "providerId" | "flowId" | "affinityKey"
>;

export type CeremonyEgressLeaseRuntime = {
	/** Exact egress bound to this ceremony; undefined until the first successful attempt binds one. */
	readonly binding: CeremonyEgressBinding | undefined;
	/**
	 * Drops the binding once its vendor session lifetime has elapsed so the next attempt
	 * selects and binds a fresh endpoint. Returns true when a binding was dropped: the
	 * caller must also discard challenge state that was only valid for that endpoint.
	 */
	dropExpiredBinding(): boolean;
	/**
	 * Drops the binding unconditionally; the stealth runtime calls this when the bound
	 * endpoint fails at the transport. Same return and caller obligation as
	 * `dropExpiredBinding`.
	 */
	dropBinding(): boolean;
	/**
	 * Number of bindings dropped so far (expiry or release). Every stealth session created
	 * from one client shares the lease; a session compares this to what it last observed to
	 * retire endpoint-bound challenge state and replay records after another session moved
	 * the ceremony.
	 */
	readonly generation: number;
	bind(binding: CeremonyEgressBinding): void;
	handle(): string | undefined;
};

/** The caller presented a handle this engine cannot verify for this ceremony (409). */
function invalidLease(): never {
	throw new SDKError("The engine ceremony egress lease is invalid", {
		code: "EGRESS_LEASE_INVALID",
		fix: "Restart the authentication ceremony to obtain a new engine-owned egress lease.",
	});
}

/** The engine violated its own binding invariant (500); never attributable to the caller. */
function bindingFault(message: string): never {
	throw new SDKError(message, {
		code: "EGRESS_LEASE_BINDING_INVALID",
		fix: "This is an SDK or provider-runtime fault; the ceremony lease cannot bind the selected egress.",
	});
}

function encryptionKey(key: string): Buffer {
	return createHash("sha256").update(AEAD_KEY_DOMAIN, "utf8").update(key, "utf8").digest();
}

/** Fixed field order and JSON.stringify's compact form are the canonical AAD encoding. */
function scopeAad(scope: CeremonyEgressLeaseScopeV1): Buffer {
	return Buffer.from(
		JSON.stringify({
			version: HANDLE_VERSION,
			tenantId: scope.tenantId,
			providerId: scope.providerId,
			flowId: scope.flowId,
			affinityKey: scope.affinityKey,
		}),
		"utf8",
	);
}

function encodeHandle(
	payload: CeremonyEgressLeasePayloadV1,
	key: string,
	scope: CeremonyEgressLeaseScopeV1,
): string {
	const nonce = randomBytes(AEAD_NONCE_BYTES);
	const cipher = createCipheriv(AEAD_ALGORITHM, encryptionKey(key), nonce, {
		authTagLength: AEAD_TAG_BYTES,
	});
	cipher.setAAD(scopeAad(scope));
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(payload), "utf8"),
		cipher.final(),
	]);
	return [
		`v${HANDLE_VERSION}`,
		nonce.toString("base64url"),
		ciphertext.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
	].join(".");
}

function isFiniteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function decodeHandle(
	handle: string,
	key: string,
	scope: CeremonyEgressLeaseScopeV1,
): CeremonyEgressLeasePayloadV1 {
	if (Buffer.byteLength(handle, "utf8") > HANDLE_MAX_BYTES) return invalidLease();
	const parts = handle.split(".");
	if (
		parts.length !== 4 ||
		parts[0] !== `v${HANDLE_VERSION}` ||
		parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))
	) {
		return invalidLease();
	}
	let parsed: unknown;
	try {
		const nonce = Buffer.from(parts[1]!, "base64url");
		const ciphertext = Buffer.from(parts[2]!, "base64url");
		const tag = Buffer.from(parts[3]!, "base64url");
		if (
			nonce.byteLength !== AEAD_NONCE_BYTES ||
			tag.byteLength !== AEAD_TAG_BYTES ||
			ciphertext.byteLength === 0
		) {
			return invalidLease();
		}
		const decipher = createDecipheriv(AEAD_ALGORITHM, encryptionKey(key), nonce, {
			authTagLength: AEAD_TAG_BYTES,
		});
		decipher.setAAD(scopeAad(scope));
		decipher.setAuthTag(tag);
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		parsed = JSON.parse(plaintext.toString("utf8"));
	} catch {
		return invalidLease();
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalidLease();
	const candidate = parsed as Partial<CeremonyEgressLeasePayloadV1>;
	if (
		candidate.version !== HANDLE_VERSION ||
		(candidate.vendor !== "smartproxy" && candidate.vendor !== "nodemaven") ||
		typeof candidate.proxyUrl !== "string" ||
		!candidate.proxyUrl ||
		!isFiniteInteger(candidate.poolIndex) ||
		typeof candidate.affinityKey !== "string" ||
		!candidate.affinityKey ||
		!isFiniteInteger(candidate.refreshEpoch) ||
		typeof candidate.tenantId !== "string" ||
		!candidate.tenantId ||
		typeof candidate.providerId !== "string" ||
		!candidate.providerId ||
		typeof candidate.flowId !== "string" ||
		!candidate.flowId ||
		!isFiniteInteger(candidate.mintedAtMs) ||
		!isFiniteInteger(candidate.expiresAtMs) ||
		candidate.expiresAtMs <= candidate.mintedAtMs ||
		!isPositiveFinite(candidate.lifetimeMinutes)
	) {
		return invalidLease();
	}
	try {
		const proxy = new URL(candidate.proxyUrl);
		if (proxy.protocol !== "http:" && proxy.protocol !== "socks5:") return invalidLease();
	} catch {
		return invalidLease();
	}
	return candidate as CeremonyEgressLeasePayloadV1;
}

function bindingOf(payload: CeremonyEgressLeasePayloadV1): CeremonyEgressBinding {
	return {
		vendor: payload.vendor,
		proxyUrl: payload.proxyUrl,
		poolIndex: payload.poolIndex,
		affinityKey: payload.affinityKey,
		refreshEpoch: payload.refreshEpoch,
		lifetimeMinutes: payload.lifetimeMinutes,
	};
}

export function createCeremonyEgressLeaseRuntime(options: {
	readonly tenantId?: string;
	readonly providerId: string;
	readonly flowId: string;
	readonly affinityKey: string;
	readonly handle?: string;
	/** Server-only registration before a handle can reach request diagnostics. */
	readonly onHandle?: (handle: string) => void;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly now?: () => number;
}): CeremonyEgressLeaseRuntime {
	const environment = options.environment ?? process.env;
	const now = options.now ?? Date.now;
	if (typeof options.tenantId !== "string" || !options.tenantId.trim()) {
		throw new SDKError("A tenant is required for an engine ceremony egress lease", {
			code: "EGRESS_LEASE_INVALID",
			fix: "Restart the authentication ceremony with its tenant identity.",
		});
	}
	const scope: CeremonyEgressLeaseScopeV1 = {
		tenantId: options.tenantId,
		providerId: options.providerId,
		flowId: options.flowId,
		affinityKey: options.affinityKey,
	};
	const key = readDiagnosticEnv(APIFUSE__ENGINE__CEREMONY_LEASE_KEY, environment)?.trim();
	if (!key) {
		throw new SDKError("The engine ceremony egress lease key is not configured", {
			code: "EGRESS_LEASE_KEY_MISSING",
			fix: `Configure ${APIFUSE__ENGINE__CEREMONY_LEASE_KEY} in the engine host.`,
		});
	}
	// The key is the whole authenticity boundary of a handle (a verified handle's proxyUrl
	// becomes the ceremony egress), so the documented minimum is enforced, not advisory.
	if (Buffer.byteLength(key, "utf8") < LEASE_KEY_MIN_BYTES) {
		throw new SDKError(
			`The engine ceremony egress lease key is shorter than ${LEASE_KEY_MIN_BYTES} bytes`,
			{
				code: "EGRESS_LEASE_KEY_WEAK",
				fix: `Set ${APIFUSE__ENGINE__CEREMONY_LEASE_KEY} to at least ${LEASE_KEY_MIN_BYTES} random bytes (for example \`openssl rand -base64 32\`).`,
			},
		);
	}
	let payload: CeremonyEgressLeasePayloadV1 | undefined;
	let currentHandle: string | undefined;
	let generation = 0;

	const dropBinding = (): boolean => {
		if (!payload) return false;
		payload = undefined;
		currentHandle = undefined;
		generation += 1;
		return true;
	};
	const dropExpiredBinding = (): boolean =>
		payload !== undefined && now() >= payload.expiresAtMs ? dropBinding() : false;

	if (options.handle !== undefined) {
		options.onHandle?.(options.handle);
		// Scope mismatch fails GCM authentication because scope is AAD; there is
		// deliberately no post-decrypt scope comparison fallback.
		payload = decodeHandle(options.handle, key, scope);
		currentHandle = options.handle;
		// An expired but authentic handle is not a fault: the ceremony continues on a
		// freshly selected endpoint and the next turn receives the new handle.
		dropExpiredBinding();
	}

	return {
		get binding() {
			return payload ? bindingOf(payload) : undefined;
		},
		dropExpiredBinding,
		dropBinding,
		get generation() {
			return generation;
		},
		bind(binding) {
			if (payload) {
				// The stealth runtime reuses the bound endpoint while a binding exists and
				// never rebinds it; a second bind is an engine invariant break.
				return bindingFault("The ceremony egress lease is already bound");
			}
			if (
				binding.affinityKey !== options.affinityKey ||
				!binding.proxyUrl ||
				(binding.vendor !== "smartproxy" && binding.vendor !== "nodemaven") ||
				!isFiniteInteger(binding.poolIndex) ||
				!isPositiveFinite(binding.lifetimeMinutes)
			) {
				return bindingFault("The selected egress cannot be bound to the ceremony lease");
			}
			const mintedAtMs = now();
			payload = {
				version: HANDLE_VERSION,
				tenantId: scope.tenantId,
				providerId: options.providerId,
				flowId: options.flowId,
				...binding,
				mintedAtMs,
				expiresAtMs: mintedAtMs + binding.lifetimeMinutes * 60_000,
			};
			currentHandle = encodeHandle(payload, key, scope);
			options.onHandle?.(currentHandle);
		},
		handle() {
			return currentHandle;
		},
	};
}
