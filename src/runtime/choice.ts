import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import {
	assertFreshProviderChoiceIssuedAt,
	ProviderChoiceTokenError,
	type ProviderChoiceTokenPayload,
} from "../choice-token.js";
import { isProviderError, ProviderError } from "../errors.js";
import type {
	CredentialContext,
	EnvContext,
	ProviderChoiceBindingOptions,
	ProviderChoiceContext,
	ProviderChoiceIssueOptions,
	ProviderChoiceParseOptions,
	ProviderChoiceStorageOptions,
	ProviderRequestContext,
	ProviderRuntimeState,
	ProviderStateDurationString,
	StateValue,
} from "../types.js";

export const PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV =
	"APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET";

const PRIMARY_CHOICE_TOKEN_KID = "v1";
const MANAGED_CHOICE_TOKEN_VERSION = 1;

type ManagedChoiceEnvelope = {
	readonly v: typeof MANAGED_CHOICE_TOKEN_VERSION;
	readonly provider_id: string;
	readonly purpose: string;
	readonly issued_at_ms: number;
	readonly ttl_ms: number;
	readonly binding?: {
		readonly connection_hash?: string;
		readonly credential_hash?: string;
	};
	readonly payload: ProviderChoiceTokenPayload;
};

type ServerChoiceHandlePayload = {
	readonly storage: "server";
	readonly state_id: string;
	readonly payload_digest: string;
	readonly created_at_ms: number;
};

export type CreateProviderChoiceContextOptions = {
	readonly providerId: string;
	readonly env?: EnvContext;
	readonly request?: ProviderRequestContext;
	readonly credential?: CredentialContext;
	readonly state?: ProviderRuntimeState;
	readonly masterSecret?: string;
	readonly kid?: string;
};

export function createProviderChoiceContext(
	options: CreateProviderChoiceContextOptions,
): ProviderChoiceContext {
	const kid = options.kid ?? PRIMARY_CHOICE_TOKEN_KID;
	const resolveMasterSecret = () => resolveChoiceMasterSecret(options);

	function issue<TPayload extends ProviderChoiceTokenPayload>(
		issueOptions: ProviderChoiceIssueOptions<TPayload> & {
			readonly storage?: { readonly mode: "inline" };
		},
	): string;
	function issue<TPayload extends ProviderChoiceTokenPayload>(
		issueOptions: ProviderChoiceIssueOptions<TPayload> & {
			readonly storage: Extract<ProviderChoiceStorageOptions, { readonly mode: "server" }>;
		},
	): Promise<string>;
	function issue<TPayload extends ProviderChoiceTokenPayload>(
		issueOptions: ProviderChoiceIssueOptions<TPayload> & {
			readonly storage: Extract<ProviderChoiceStorageOptions, { readonly mode: "auto" }>;
		},
	): string | Promise<string>;
	function issue<TPayload extends ProviderChoiceTokenPayload>(
		issueOptions: ProviderChoiceIssueOptions<TPayload>,
	): string | Promise<string> {
		const issuedAtMs = issueOptions.nowMs ?? Date.now();
		const keys = deriveManagedChoiceKeys({
			masterSecret: resolveMasterSecret(),
			providerId: options.providerId,
			purpose: issueOptions.purpose,
			kid,
		});
		const baseEnvelope: Omit<ManagedChoiceEnvelope, "payload"> = {
			v: MANAGED_CHOICE_TOKEN_VERSION,
			provider_id: options.providerId,
			purpose: issueOptions.purpose,
			issued_at_ms: issuedAtMs,
			ttl_ms: issueOptions.ttlMs,
			binding: createChoiceBinding({
				keys,
				options: issueOptions.bind,
				request: options.request,
				credential: options.credential,
				required: true,
			}),
		};
		const resolvedStorage = resolveIssueStorage(issueOptions.storage, issueOptions.payload);
		if (resolvedStorage.mode === "server") {
			return issueServerStoredChoice({
				baseEnvelope,
				issueOptions,
				storage: resolvedStorage.storage,
				contextState: options.state,
				kid,
				keys,
				issuedAtMs,
			});
		}
		const envelope: ManagedChoiceEnvelope = {
			...baseEnvelope,
			payload: issueOptions.payload,
		};
		return encryptManagedChoiceToken({
			prefix: issueOptions.prefix,
			kid,
			envelope,
			keys,
		});
	}

	function parse(
		parseOptions: ProviderChoiceParseOptions & {
			readonly storage?: { readonly mode: "inline" };
		},
	): ProviderChoiceTokenPayload;
	function parse(
		parseOptions: ProviderChoiceParseOptions & {
			readonly storage: Extract<ProviderChoiceStorageOptions, { readonly mode: "server" }>;
		},
	): Promise<ProviderChoiceTokenPayload>;
	function parse(
		parseOptions: ProviderChoiceParseOptions & {
			readonly storage: Extract<ProviderChoiceStorageOptions, { readonly mode: "auto" }>;
		},
	): ProviderChoiceTokenPayload | Promise<ProviderChoiceTokenPayload>;
	function parse(
		parseOptions: ProviderChoiceParseOptions,
	): ProviderChoiceTokenPayload | Promise<ProviderChoiceTokenPayload> {
		const [actualPrefix, tokenKid, encodedIv, encryptedPayload, authTag, signature] =
			parseManagedChoiceTokenParts(parseOptions.token);
		if (
			actualPrefix !== parseOptions.prefix ||
			tokenKid !== kid ||
			!encodedIv ||
			!encryptedPayload ||
			!authTag ||
			!signature
		) {
			throw new ProviderChoiceTokenError(
				"invalid_shape",
				"Provider choice token shape is invalid.",
			);
		}

		const keys = deriveManagedChoiceKeys({
			masterSecret: resolveMasterSecret(),
			providerId: options.providerId,
			purpose: parseOptions.purpose,
			kid: tokenKid,
		});
		const signedBody = [parseOptions.prefix, tokenKid, encodedIv, encryptedPayload, authTag].join(
			".",
		);
		assertManagedChoiceSignature({
			signedBody,
			signature,
			signingKey: keys.signing,
		});
		const envelope = decryptManagedChoiceToken({
			encodedIv,
			encryptedPayload,
			authTag,
			encryptionKey: keys.encryption,
		});
		assertManagedChoiceEnvelope(envelope, {
			providerId: options.providerId,
			purpose: parseOptions.purpose,
			ttlMs: parseOptions.ttlMs,
			nowMs: parseOptions.nowMs,
			futureToleranceMs: parseOptions.futureToleranceMs,
		});
		assertChoiceBindingMatches({
			actual: envelope.binding,
			expected: createChoiceBinding({
				keys,
				options: parseOptions.bind,
				request: options.request,
				credential: options.credential,
				required: true,
			}),
		});
		if (isServerChoiceHandlePayload(envelope.payload)) {
			return parseServerStoredChoice({
				handle: envelope.payload,
				storage: parseOptions.storage,
				contextState: options.state,
			});
		}
		return envelope.payload;
	}

	return { issue, parse };
}

export function createTestProviderChoiceContext(
	options: Omit<CreateProviderChoiceContextOptions, "masterSecret"> & {
		readonly masterSecret?: string;
	},
): ProviderChoiceContext {
	return createProviderChoiceContext({
		...options,
		masterSecret:
			options.masterSecret ?? "apifuse-test-provider-runtime-choice-token-master-secret",
	});
}

function resolveChoiceMasterSecret(options: CreateProviderChoiceContextOptions): string {
	const configured =
		options.masterSecret ?? options.env?.get(PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV);
	const trimmed = configured?.trim();
	if (trimmed) return trimmed;
	throw new ProviderError("Provider runtime choice-token master secret is not configured.", {
		code: "CHOICE_TOKEN_MASTER_SECRET_NOT_CONFIGURED",
		category: "internal_error",
		retryable: false,
		details: {
			secret: PROVIDER_RUNTIME_CHOICE_TOKEN_MASTER_SECRET_ENV,
		},
	});
}

type ManagedChoiceKeyInput = {
	readonly masterSecret: string;
	readonly providerId: string;
	readonly purpose: string;
	readonly kid: string;
};

type ManagedChoiceKeys = {
	readonly encryption: Buffer;
	readonly signing: Buffer;
	readonly binding: Buffer;
};

function deriveManagedChoiceKeys(input: ManagedChoiceKeyInput): ManagedChoiceKeys {
	return {
		encryption: deriveManagedChoiceKey(input, "encryption"),
		signing: deriveManagedChoiceKey(input, "signing"),
		binding: deriveManagedChoiceKey(input, "binding"),
	};
}

function deriveManagedChoiceKey(
	input: ManagedChoiceKeyInput,
	usage: "encryption" | "signing" | "binding",
): Buffer {
	return createHmac("sha256", input.masterSecret)
		.update("apifuse-provider-choice-token")
		.update("\0")
		.update(input.providerId)
		.update("\0")
		.update(input.purpose)
		.update("\0")
		.update(input.kid)
		.update("\0")
		.update(usage)
		.digest();
}

function encryptManagedChoiceToken(options: {
	readonly prefix: string;
	readonly kid: string;
	readonly envelope: ManagedChoiceEnvelope;
	readonly keys: ManagedChoiceKeys;
}): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", options.keys.encryption, iv);
	const encryptedPayload = Buffer.concat([
		cipher.update(JSON.stringify(options.envelope), "utf8"),
		cipher.final(),
	]).toString("base64url");
	const authTag = cipher.getAuthTag().toString("base64url");
	const encodedIv = iv.toString("base64url");
	const signedBody = [options.prefix, options.kid, encodedIv, encryptedPayload, authTag].join(".");
	const signature = createHmac("sha256", options.keys.signing)
		.update(signedBody)
		.digest("base64url");
	return `${signedBody}.${signature}`;
}

async function issueServerStoredChoice<TPayload extends ProviderChoiceTokenPayload>(options: {
	readonly baseEnvelope: Omit<ManagedChoiceEnvelope, "payload">;
	readonly issueOptions: ProviderChoiceIssueOptions<TPayload>;
	readonly storage: ServerProviderChoiceStorageOptions;
	readonly contextState?: ProviderRuntimeState;
	readonly kid: string;
	readonly keys: ManagedChoiceKeys;
	readonly issuedAtMs: number;
}): Promise<string> {
	const serializedPayload = serializeChoicePayload(options.issueOptions.payload);
	const payloadBytes = Buffer.byteLength(serializedPayload, "utf8");
	if (payloadBytes > options.storage.maxValueBytes) {
		throw new ProviderError("Provider choice payload exceeds state storage policy.", {
			code: "CHOICE_STATE_PAYLOAD_TOO_LARGE",
			category: "input_validation",
			retryable: false,
			details: {
				maxValueBytes: options.storage.maxValueBytes,
				payloadBytes,
			},
		});
	}
	const stateId = `choice_${randomBytes(16).toString("base64url")}`;
	const digest = digestChoicePayload(serializedPayload);
	const namespace = resolveChoiceStateNamespace({
		storage: options.storage,
		contextState: options.contextState,
		ttlMs: options.issueOptions.ttlMs,
	});
	await namespace.set(optionsStateKey(stateId), options.issueOptions.payload, {
		ttl: stateTtl(options.storage, options.issueOptions.ttlMs),
	});
	const envelope: ManagedChoiceEnvelope = {
		...options.baseEnvelope,
		payload: {
			storage: "server",
			state_id: stateId,
			payload_digest: digest,
			created_at_ms: options.issuedAtMs,
		},
	};
	return encryptManagedChoiceToken({
		prefix: options.issueOptions.prefix,
		kid: options.kid,
		envelope,
		keys: options.keys,
	});
}

async function parseServerStoredChoice(options: {
	readonly handle: ServerChoiceHandlePayload;
	readonly storage?: ProviderChoiceStorageOptions;
	readonly contextState?: ProviderRuntimeState;
}): Promise<ProviderChoiceTokenPayload> {
	const storage = resolveParseStorage(options.storage);
	const namespace = resolveChoiceStateNamespace({
		storage,
		contextState: options.contextState,
	});
	// Reading a server-stored choice back deserializes a persisted value. A
	// corrupt/undecodable value would otherwise surface as a raw JSON.parse
	// SyntaxError (or another unexpected throwable) that escapes the choice error
	// taxonomy, gets masked as internal_error 500, and is treated as retryable by
	// the hub -> reservation restart loop (2026-07-22 catchtable RCA, candidate A).
	// Convert any non-branded throwable into a branded invalid_payload so it maps
	// to a clean, non-retryable 400. Branded ProviderChoiceTokenError and genuine
	// ProviderError (e.g. Redis-unavailable / state-unavailable) pass through so
	// their category/retryable semantics are preserved.
	let record: StateValue<ProviderChoiceTokenPayload> | null;
	try {
		record = await namespace.get<ProviderChoiceTokenPayload>(
			optionsStateKey(options.handle.state_id),
		);
	} catch (error) {
		if (error instanceof ProviderChoiceTokenError || isProviderError(error)) {
			throw error;
		}
		throw new ProviderChoiceTokenError(
			"invalid_payload",
			"Provider choice token state payload could not be decoded.",
		);
	}
	if (!record) {
		throw new ProviderChoiceTokenError(
			"invalid_payload",
			"Provider choice token state payload is missing.",
		);
	}
	const serializedPayload = serializeChoicePayload(record.value);
	assertPayloadDigestMatches({
		actual: digestChoicePayload(serializedPayload),
		expected: options.handle.payload_digest,
	});
	return record.value;
}

type ServerProviderChoiceStorageOptions = Extract<
	ProviderChoiceStorageOptions,
	{ readonly mode: "server" | "auto" }
>;

function resolveIssueStorage<TPayload extends ProviderChoiceTokenPayload>(
	storage: ProviderChoiceStorageOptions | undefined,
	payload: TPayload,
):
	| { readonly mode: "inline" }
	| {
			readonly mode: "server";
			readonly storage: ServerProviderChoiceStorageOptions;
	  } {
	if (!storage || storage.mode === "inline") return { mode: "inline" };
	if (storage.mode === "server") return { mode: "server", storage };
	const payloadBytes = Buffer.byteLength(serializeChoicePayload(payload), "utf8");
	if (payloadBytes <= storage.maxInlineBytes) return { mode: "inline" };
	return { mode: "server", storage };
}

function resolveParseStorage(
	storage: ProviderChoiceStorageOptions | undefined,
): ServerProviderChoiceStorageOptions {
	if (!storage || storage.mode === "inline") {
		throw new ProviderChoiceTokenError(
			"invalid_payload",
			"Provider choice token requires server-side choice storage.",
		);
	}
	return storage;
}

function resolveChoiceStateNamespace(options: {
	readonly storage: ServerProviderChoiceStorageOptions;
	readonly contextState?: ProviderRuntimeState;
	readonly ttlMs?: number;
}) {
	const state = options.storage.state ?? options.contextState;
	if (!state) {
		throw new ProviderError("Provider choice state storage is not available.", {
			code: "CHOICE_STATE_UNAVAILABLE",
			category: "internal_error",
			retryable: false,
		});
	}
	return state.namespace(options.storage.namespace, {
		defaultTtl: stateTtl(options.storage, options.ttlMs),
		maxTtl: stateTtl(options.storage, options.ttlMs),
		maxEntries: options.storage.maxEntries,
		maxValueBytes: options.storage.maxValueBytes,
	});
}

function stateTtl(
	storage: ServerProviderChoiceStorageOptions,
	ttlMs?: number,
): ProviderStateDurationString {
	return storage.ttl ?? `${ttlMs ?? 1}ms`;
}

function optionsStateKey(stateId: string): string {
	return stateId;
}

function serializeChoicePayload(payload: ProviderChoiceTokenPayload): string {
	return JSON.stringify(payload);
}

function digestChoicePayload(serializedPayload: string): string {
	return createHash("sha256").update(serializedPayload).digest("base64url");
}

function isServerChoiceHandlePayload(
	value: ProviderChoiceTokenPayload,
): value is ServerChoiceHandlePayload {
	return (
		value.storage === "server" &&
		typeof value.state_id === "string" &&
		typeof value.payload_digest === "string" &&
		typeof value.created_at_ms === "number"
	);
}

function assertPayloadDigestMatches(options: {
	readonly actual: string;
	readonly expected: string;
}): void {
	const actual = Buffer.from(options.actual);
	const expected = Buffer.from(options.expected);
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		throw new ProviderChoiceTokenError(
			"invalid_payload",
			"Provider choice token state payload digest is invalid.",
		);
	}
}

function parseManagedChoiceTokenParts(
	token: string,
): readonly [
	string | undefined,
	string | undefined,
	string | undefined,
	string | undefined,
	string | undefined,
	string | undefined,
] {
	const parts = token.split(".");
	if (parts.length !== 6) {
		throw new ProviderChoiceTokenError("invalid_shape", "Provider choice token shape is invalid.");
	}
	return [parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]];
}

function assertManagedChoiceSignature(options: {
	readonly signedBody: string;
	readonly signature: string;
	readonly signingKey: Buffer;
}): void {
	const expected = createHmac("sha256", options.signingKey)
		.update(options.signedBody)
		.digest("base64url");
	const actualBuffer = Buffer.from(options.signature);
	const expectedBuffer = Buffer.from(expected);
	if (
		actualBuffer.length !== expectedBuffer.length ||
		!timingSafeEqual(actualBuffer, expectedBuffer)
	) {
		throw new ProviderChoiceTokenError(
			"invalid_signature",
			"Provider choice token signature is invalid.",
		);
	}
}

function decryptManagedChoiceToken(options: {
	readonly encodedIv: string;
	readonly encryptedPayload: string;
	readonly authTag: string;
	readonly encryptionKey: Buffer;
}): ManagedChoiceEnvelope {
	try {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			options.encryptionKey,
			Buffer.from(options.encodedIv, "base64url"),
		);
		decipher.setAuthTag(Buffer.from(options.authTag, "base64url"));
		const decrypted = Buffer.concat([
			decipher.update(Buffer.from(options.encryptedPayload, "base64url")),
			decipher.final(),
		]).toString("utf8");
		const parsed: unknown = JSON.parse(decrypted);
		if (!isManagedChoiceEnvelope(parsed)) {
			throw new ProviderChoiceTokenError(
				"invalid_payload",
				"Provider choice token payload is invalid.",
			);
		}
		return parsed;
	} catch (error) {
		if (error instanceof ProviderChoiceTokenError) {
			throw error;
		}
		throw new ProviderChoiceTokenError(
			"invalid_payload",
			"Provider choice token payload is invalid.",
		);
	}
}

function isManagedChoiceEnvelope(value: unknown): value is ManagedChoiceEnvelope {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!("payload" in value) || !isChoicePayload(value.payload)) return false;
	return (
		"v" in value &&
		value.v === MANAGED_CHOICE_TOKEN_VERSION &&
		"provider_id" in value &&
		typeof value.provider_id === "string" &&
		"purpose" in value &&
		typeof value.purpose === "string" &&
		"issued_at_ms" in value &&
		typeof value.issued_at_ms === "number" &&
		"ttl_ms" in value &&
		typeof value.ttl_ms === "number" &&
		(!("binding" in value) || value.binding === undefined || isChoiceBinding(value.binding))
	);
}

function isChoicePayload(value: unknown): value is ProviderChoiceTokenPayload {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isChoiceBinding(value: unknown): value is ManagedChoiceEnvelope["binding"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		(!("connection_hash" in value) || typeof value.connection_hash === "string") &&
		(!("credential_hash" in value) || typeof value.credential_hash === "string")
	);
}

function assertManagedChoiceEnvelope(
	envelope: ManagedChoiceEnvelope,
	options: {
		readonly providerId: string;
		readonly purpose: string;
		readonly ttlMs?: number;
		readonly nowMs?: number;
		readonly futureToleranceMs?: number;
	},
): void {
	if (envelope.provider_id !== options.providerId || envelope.purpose !== options.purpose) {
		throw new ProviderChoiceTokenError(
			"invalid_payload",
			"Provider choice token payload is invalid.",
		);
	}
	assertFreshProviderChoiceIssuedAt(envelope.issued_at_ms, {
		// Clamp to the issuer's embedded TTL so a caller-supplied value cannot
		// silently extend token validity past the deadline the issuer intended.
		ttlMs: options.ttlMs != null ? Math.min(options.ttlMs, envelope.ttl_ms) : envelope.ttl_ms,
		nowMs: options.nowMs,
		futureToleranceMs: options.futureToleranceMs,
	});
}

function createChoiceBinding(options: {
	readonly keys: ManagedChoiceKeys;
	readonly options?: ProviderChoiceBindingOptions;
	readonly request?: ProviderRequestContext;
	readonly credential?: CredentialContext;
	readonly required: boolean;
}): ManagedChoiceEnvelope["binding"] {
	const connectionHash = options.options?.connection ? hashRequiredConnection(options) : undefined;
	const credentialHash = options.options?.credentialKeys?.length
		? hashCredentialKeys(options)
		: undefined;
	if (!connectionHash && !credentialHash) return undefined;
	return {
		...(connectionHash ? { connection_hash: connectionHash } : {}),
		...(credentialHash ? { credential_hash: credentialHash } : {}),
	};
}

function hashRequiredConnection(options: {
	readonly keys: ManagedChoiceKeys;
	readonly request?: ProviderRequestContext;
	readonly required: boolean;
}): string | undefined {
	const connectionId = options.request?.connectionId;
	if (!connectionId) {
		if (!options.required) return undefined;
		throw new ProviderError("Provider choice tokens require connection context.", {
			code: "CHOICE_CONTEXT_REQUIRED",
			category: "input_validation",
			retryable: false,
		});
	}
	return createHmac("sha256", options.keys.binding)
		.update("connection")
		.update("\0")
		.update(connectionId)
		.digest("base64url");
}

function hashCredentialKeys(options: {
	readonly keys: ManagedChoiceKeys;
	readonly options?: ProviderChoiceBindingOptions;
	readonly credential?: CredentialContext;
}): string {
	const credentialKeys = options.options?.credentialKeys ?? [];
	const material = credentialKeys.map((key) => {
		const value = options.credential?.get(key);
		if (typeof value !== "string" || value.length === 0) {
			throw new ProviderError("Provider choice tokens require configured credential binding.", {
				code: "CHOICE_CONTEXT_REQUIRED",
				category: "input_validation",
				retryable: false,
				details: { credentialKey: key },
			});
		}
		return [key, value];
	});
	return createHmac("sha256", options.keys.binding)
		.update("credential")
		.update("\0")
		.update(JSON.stringify(material))
		.digest("base64url");
}

function assertChoiceBindingMatches(options: {
	readonly actual: ManagedChoiceEnvelope["binding"];
	readonly expected: ManagedChoiceEnvelope["binding"];
}): void {
	if (options.actual?.connection_hash !== options.expected?.connection_hash) {
		throw new ProviderChoiceTokenError(
			"invalid_binding",
			"Provider choice token connection binding is invalid.",
		);
	}
	if (options.actual?.credential_hash !== options.expected?.credential_hash) {
		throw new ProviderChoiceTokenError(
			"invalid_binding",
			"Provider choice token credential binding is invalid.",
		);
	}
}
