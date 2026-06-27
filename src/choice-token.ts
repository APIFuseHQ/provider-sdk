import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";

export type ProviderChoiceTokenPayload = Record<string, unknown>;

export type ProviderChoiceTokenErrorReason =
	| "invalid_shape"
	| "invalid_signature"
	| "invalid_payload"
	| "invalid_binding"
	| "stale";

export class ProviderChoiceTokenError extends Error {
	readonly reason: ProviderChoiceTokenErrorReason;

	constructor(reason: ProviderChoiceTokenErrorReason, message: string) {
		super(message);
		this.name = "ProviderChoiceTokenError";
		this.reason = reason;
	}
}

export interface CreateProviderChoiceTokenOptions<
	TPayload extends ProviderChoiceTokenPayload,
> {
	prefix: string;
	payload: TPayload;
	secret: string;
}

export interface ParseProviderChoiceTokenOptions {
	token: string;
	prefix: string;
	secret: string;
}

export interface FreshProviderChoiceIssuedAtOptions {
	ttlMs: number;
	nowMs?: number;
	futureToleranceMs?: number;
}

export function createProviderChoiceToken<
	TPayload extends ProviderChoiceTokenPayload,
>(options: CreateProviderChoiceTokenOptions<TPayload>): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv(
		"aes-256-gcm",
		choiceEncryptionKey(options.secret),
		iv,
	);
	const encryptedPayload = Buffer.concat([
		cipher.update(JSON.stringify(options.payload), "utf8"),
		cipher.final(),
	]).toString("base64url");
	const authTag = cipher.getAuthTag().toString("base64url");
	const encodedIv = iv.toString("base64url");
	const signature = signProviderChoiceTokenBody(
		`${options.prefix}.${encodedIv}.${encryptedPayload}.${authTag}`,
		options.secret,
	);
	return `${options.prefix}.${encodedIv}.${encryptedPayload}.${authTag}.${signature}`;
}

export function parseProviderChoiceToken(
	options: ParseProviderChoiceTokenOptions,
): ProviderChoiceTokenPayload {
	const [
		actualPrefix,
		encodedIv,
		encryptedPayload,
		authTag,
		signature,
		...extra
	] = options.token.split(".");
	if (
		actualPrefix !== options.prefix ||
		!encodedIv ||
		!encryptedPayload ||
		!authTag ||
		!signature ||
		extra.length > 0
	) {
		throw new ProviderChoiceTokenError(
			"invalid_shape",
			"Provider choice token shape is invalid.",
		);
	}

	const signedBody = `${options.prefix}.${encodedIv}.${encryptedPayload}.${authTag}`;
	const expectedSignature = signProviderChoiceTokenBody(
		signedBody,
		options.secret,
	);
	const actualBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expectedSignature);
	if (
		actualBuffer.length !== expectedBuffer.length ||
		!timingSafeEqual(actualBuffer, expectedBuffer)
	) {
		throw new ProviderChoiceTokenError(
			"invalid_signature",
			"Provider choice token signature is invalid.",
		);
	}

	try {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			choiceEncryptionKey(options.secret),
			Buffer.from(encodedIv, "base64url"),
		);
		decipher.setAuthTag(Buffer.from(authTag, "base64url"));
		const decrypted = Buffer.concat([
			decipher.update(Buffer.from(encryptedPayload, "base64url")),
			decipher.final(),
		]).toString("utf8");
		const parsed = JSON.parse(decrypted);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("payload is not an object");
		}
		return Object.fromEntries(Object.entries(parsed));
	} catch {
		throw new ProviderChoiceTokenError(
			"invalid_payload",
			"Provider choice token payload is invalid.",
		);
	}
}

export function assertFreshProviderChoiceIssuedAt(
	issuedAtMs: unknown,
	options: FreshProviderChoiceIssuedAtOptions,
): number {
	const parsed =
		typeof issuedAtMs === "number" ? issuedAtMs : Number(issuedAtMs);
	const nowMs = options.nowMs ?? Date.now();
	const futureToleranceMs = options.futureToleranceMs ?? 30_000;
	if (
		!Number.isFinite(parsed) ||
		parsed <= 0 ||
		nowMs - parsed > options.ttlMs ||
		parsed - nowMs > futureToleranceMs
	) {
		throw new ProviderChoiceTokenError(
			"stale",
			"Provider choice token is stale.",
		);
	}
	return parsed;
}

function choiceEncryptionKey(secret: string): Buffer {
	return createHash("sha256").update(secret).digest();
}

function signProviderChoiceTokenBody(body: string, secret: string): string {
	return createHmac("sha256", secret).update(body).digest("base64url");
}
