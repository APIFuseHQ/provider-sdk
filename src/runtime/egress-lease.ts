import { createHmac, timingSafeEqual } from "node:crypto";

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

function sign(encodedPayload: string, key: string): Buffer {
	return createHmac("sha256", key).update(encodedPayload, "utf8").digest();
}

function encodeHandle(payload: CeremonyEgressLeasePayloadV1, key: string): string {
	const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${encodedPayload}.${sign(encodedPayload, key).toString("base64url")}`;
}

function isFiniteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeHandle(handle: string, key: string): CeremonyEgressLeasePayloadV1 {
	if (Buffer.byteLength(handle, "utf8") > HANDLE_MAX_BYTES) return invalidLease();
	const parts = handle.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return invalidLease();
	let suppliedSignature: Buffer;
	try {
		suppliedSignature = Buffer.from(parts[1], "base64url");
	} catch {
		return invalidLease();
	}
	const expectedSignature = sign(parts[0], key);
	if (
		suppliedSignature.byteLength !== expectedSignature.byteLength ||
		!timingSafeEqual(suppliedSignature, expectedSignature)
	) {
		return invalidLease();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
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
	let payload: CeremonyEgressLeasePayloadV1 | undefined;
	let currentHandle: string | undefined;

	if (options.handle !== undefined) {
		if (!key) return invalidLease();
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
			if (!key) {
				throw new SDKError("The engine ceremony egress lease key is not configured", {
					code: "EGRESS_LEASE_KEY_MISSING",
					fix: `Configure ${APIFUSE__ENGINE__CEREMONY_LEASE_HMAC_KEY} in the engine host.`,
				});
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
