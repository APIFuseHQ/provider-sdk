import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { ProxyVendorName } from "../config/loader.js";
import { SDKError } from "../errors.js";

export const APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY = "APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY";
export const APIFUSE__ENGINE__CEREMONY_LEASE_NODEMAVEN_TTL_MS =
	"APIFUSE__ENGINE__CEREMONY_LEASE_NODEMAVEN_TTL_MS";
export const APIFUSE__ENGINE__CEREMONY_LEASE_SMARTPROXY_TTL_MS =
	"APIFUSE__ENGINE__CEREMONY_LEASE_SMARTPROXY_TTL_MS";

/** Internal option key shared only by the server assembler and stealth runtime. */
export const ENGINE_CEREMONY_EGRESS_LEASE = Symbol.for(
	"@apifuse/provider-sdk/engine-ceremony-egress-lease",
);

export const ENGINE_OWNED_CEREMONY_LEASE_ENV_NAMES = [
	APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY,
	APIFUSE__ENGINE__CEREMONY_LEASE_NODEMAVEN_TTL_MS,
	APIFUSE__ENGINE__CEREMONY_LEASE_SMARTPROXY_TTL_MS,
] as const;

const HANDLE_VERSION = 1;
const HANDLE_MAX_BYTES = 16_384;
const AEAD_NONCE_BYTES = 12;
const AEAD_TAG_BYTES = 16;
const AEAD_ALGORITHM = "aes-256-gcm";
const AEAD_KEY_DOMAIN = "apifuse:ceremony-egress-lease:v1\0";
const DEFAULT_NODEMAVEN_TTL_MS = 24 * 60 * 60 * 1_000;
// Smartproxy extraction results are cached for only 15 seconds because a raw
// endpoint is not a vendor-guaranteed lease (config/loader.ts).
const DEFAULT_SMARTPROXY_TTL_MS = 15_000;

export type CeremonyEgressBinding = {
	readonly vendor: ProxyVendorName;
	readonly proxyUrl: string;
	readonly poolIndex: number;
	readonly affinityKey: string;
	readonly refreshEpoch: number;
	readonly lifetimeMinutes?: number;
};

type CeremonyEgressLeasePayloadV1 = CeremonyEgressBinding & {
	readonly version: typeof HANDLE_VERSION;
	readonly providerId: string;
	readonly flowId: string;
	readonly mintedAtMs: number;
	readonly expiresAtMs: number;
};

export type CeremonyEgressLeaseRuntime = {
	readonly binding: CeremonyEgressBinding | undefined;
	assertActive(): void;
	bind(binding: CeremonyEgressBinding): void;
	handle(): string | undefined;
};

function invalidLease(): never {
	throw new SDKError("The engine ceremony egress lease is invalid", {
		code: "EGRESS_LEASE_INVALID",
		fix: "Restart the authentication ceremony to obtain a new engine-owned egress lease.",
	});
}

function expiredLease(): never {
	throw new SDKError("The engine ceremony egress lease has expired", {
		code: "EGRESS_LEASE_EXPIRED",
		fix: "Restart the authentication ceremony to obtain a fresh engine-owned egress lease.",
	});
}

function positiveIntegerEnv(
	environment: Readonly<Record<string, string | undefined>>,
	name: string,
): number | undefined {
	const raw = environment[name]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new SDKError(`${name} must be a positive integer number of milliseconds`, {
			code: "EGRESS_LEASE_INVALID",
		});
	}
	return value;
}

function ttlMsForBinding(
	binding: CeremonyEgressBinding,
	environment: Readonly<Record<string, string | undefined>>,
): number {
	if (binding.vendor === "smartproxy") {
		return (
			positiveIntegerEnv(environment, APIFUSE__ENGINE__CEREMONY_LEASE_SMARTPROXY_TTL_MS) ??
			DEFAULT_SMARTPROXY_TTL_MS
		);
	}
	return (
		positiveIntegerEnv(environment, APIFUSE__ENGINE__CEREMONY_LEASE_NODEMAVEN_TTL_MS) ??
		(binding.lifetimeMinutes === undefined
			? DEFAULT_NODEMAVEN_TTL_MS
			: binding.lifetimeMinutes * 60_000)
	);
}

function encryptionKey(key: string): Buffer {
	return createHash("sha256").update(AEAD_KEY_DOMAIN, "utf8").update(key, "utf8").digest();
}

function encodeHandle(payload: CeremonyEgressLeasePayloadV1, key: string): string {
	const nonce = randomBytes(AEAD_NONCE_BYTES);
	const cipher = createCipheriv(AEAD_ALGORITHM, encryptionKey(key), nonce, {
		authTagLength: AEAD_TAG_BYTES,
	});
	cipher.setAAD(Buffer.from(`v${HANDLE_VERSION}`, "utf8"));
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

function decodeHandle(handle: string, key: string): CeremonyEgressLeasePayloadV1 {
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
		decipher.setAAD(Buffer.from(parts[0]!, "utf8"));
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
		typeof candidate.providerId !== "string" ||
		!candidate.providerId ||
		typeof candidate.flowId !== "string" ||
		!candidate.flowId ||
		!isFiniteInteger(candidate.mintedAtMs) ||
		!isFiniteInteger(candidate.expiresAtMs) ||
		candidate.expiresAtMs <= candidate.mintedAtMs ||
		(candidate.lifetimeMinutes !== undefined &&
			(typeof candidate.lifetimeMinutes !== "number" ||
				!Number.isFinite(candidate.lifetimeMinutes) ||
				candidate.lifetimeMinutes <= 0))
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

export function createCeremonyEgressLeaseRuntime(options: {
	readonly providerId: string;
	readonly flowId: string;
	readonly affinityKey: string;
	readonly handle?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly now?: () => number;
}): CeremonyEgressLeaseRuntime {
	const environment = options.environment ?? process.env;
	const now = options.now ?? Date.now;
	const key = environment[APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY]?.trim();
	if (!key) {
		throw new SDKError("The engine ceremony egress lease key is not configured", {
			code: "EGRESS_LEASE_KEY_MISSING",
			fix: `Configure ${APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY} in the engine host.`,
		});
	}
	let payload: CeremonyEgressLeasePayloadV1 | undefined;
	let currentHandle: string | undefined;

	if (options.handle !== undefined) {
		payload = decodeHandle(options.handle, key);
		if (
			payload.providerId !== options.providerId ||
			payload.flowId !== options.flowId ||
			payload.affinityKey !== options.affinityKey
		) {
			return invalidLease();
		}
		if (now() >= payload.expiresAtMs) return expiredLease();
		currentHandle = options.handle;
	}

	return {
		get binding() {
			if (!payload) return undefined;
			return {
				vendor: payload.vendor,
				proxyUrl: payload.proxyUrl,
				poolIndex: payload.poolIndex,
				affinityKey: payload.affinityKey,
				refreshEpoch: payload.refreshEpoch,
				...(payload.lifetimeMinutes === undefined
					? {}
					: { lifetimeMinutes: payload.lifetimeMinutes }),
			};
		},
		assertActive() {
			if (payload && now() >= payload.expiresAtMs) return expiredLease();
		},
		bind(binding) {
			if (
				binding.affinityKey !== options.affinityKey ||
				!binding.proxyUrl ||
				(binding.vendor !== "smartproxy" && binding.vendor !== "nodemaven")
			) {
				return invalidLease();
			}
			if (payload) {
				if (
					payload.vendor !== binding.vendor ||
					payload.proxyUrl !== binding.proxyUrl ||
					payload.poolIndex !== binding.poolIndex ||
					payload.refreshEpoch !== binding.refreshEpoch
				) {
					return invalidLease();
				}
				return;
			}
			const mintedAtMs = now();
			payload = {
				version: HANDLE_VERSION,
				providerId: options.providerId,
				flowId: options.flowId,
				vendor: binding.vendor,
				proxyUrl: binding.proxyUrl,
				poolIndex: binding.poolIndex,
				affinityKey: binding.affinityKey,
				refreshEpoch: binding.refreshEpoch,
				...(binding.lifetimeMinutes === undefined
					? {}
					: { lifetimeMinutes: binding.lifetimeMinutes }),
				mintedAtMs,
				expiresAtMs: mintedAtMs + ttlMsForBinding(binding, environment),
			};
			currentHandle = encodeHandle(payload, key);
		},
		handle() {
			return currentHandle;
		},
	};
}
