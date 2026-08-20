import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from "node:crypto";
import {
	assertFreshProviderChoiceIssuedAt,
	ProviderChoiceTokenError,
	type ProviderChoiceTokenPayload,
} from "../choice-token.js";
import { isProviderError, ProviderError } from "../errors.js";
import {
	CHOICE_WORDLIST_SIZE,
	choiceWordAt,
	HIGH_CHOICE_WORD_COUNT,
	isChoiceWord,
	STANDARD_CHOICE_WORD_COUNT,
} from "./choice-wordlist.js";
import type {
	CredentialContext,
	EnvContext,
	ProviderChoiceBindingOptions,
	ProviderChoiceConsumeMode,
	ProviderChoiceConsumeResult,
	ProviderChoiceContext,
	ProviderChoiceExplicitParseResult,
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
const SERVER_STORED_CHOICE_RECORD_VERSION = 1;
const SERVER_STORED_CHOICE_ISSUE_ATTEMPTS = 5;
const WORD_CHOICE_NOT_FOUND_MESSAGE = "Provider choice token was not found.";

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

type ServerStoredChoiceRecord = {
	readonly v: typeof SERVER_STORED_CHOICE_RECORD_VERSION;
	readonly storage: "server";
	readonly status: "active" | "consumed";
	readonly provider_id: string;
	readonly purpose: string;
	readonly issued_at_ms: number;
	readonly ttl_ms: number;
	readonly binding?: ManagedChoiceEnvelope["binding"];
	readonly prefix: string;
	readonly payload: ProviderChoiceTokenPayload;
	readonly payload_digest: string;
	readonly replay_key: string;
};

export type ProviderChoiceTelemetryEvent = {
	readonly providerId: string;
	readonly purpose: string;
	readonly operation: "parse" | "consume";
	readonly format: "word" | "legacy";
	readonly outcome: "success" | "not-found" | "invalid" | "unsupported" | "error";
	readonly consumeMode: ProviderChoiceConsumeMode;
	readonly consumed: boolean;
	readonly replay: boolean;
};

export type CreateProviderChoiceContextOptions = {
	readonly providerId: string;
	readonly env?: EnvContext;
	readonly request?: ProviderRequestContext;
	readonly credential?: CredentialContext;
	readonly state?: ProviderRuntimeState;
	readonly masterSecret?: string;
	readonly kid?: string;
	/** Receives allowlisted metadata only; token and payload values are never included. */
	readonly onTelemetry?: (event: ProviderChoiceTelemetryEvent) => void;
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
		const resolvedStorage = resolveIssueStorage(issueOptions.storage, issueOptions.payload);
		if (resolvedStorage.mode === "server") {
			const keys = hasRequestedChoiceBinding(issueOptions.bind)
				? deriveManagedChoiceKeys({
						masterSecret: resolveMasterSecret(),
						providerId: options.providerId,
						purpose: issueOptions.purpose,
						kid,
					})
				: undefined;
			const binding = hasRequestedChoiceBinding(issueOptions.bind)
				? createChoiceBinding({
						keys: keys!,
						options: issueOptions.bind,
						request: options.request,
						credential: options.credential,
						required: true,
					})
				: undefined;
			const baseEnvelope = {
				v: MANAGED_CHOICE_TOKEN_VERSION,
				provider_id: options.providerId,
				purpose: issueOptions.purpose,
				issued_at_ms: issuedAtMs,
				ttl_ms: issueOptions.ttlMs,
				binding,
			} satisfies Omit<ManagedChoiceEnvelope, "payload">;
			return issueWordServerStoredChoice({
				baseEnvelope,
				issueOptions,
				storage: resolvedStorage.storage,
				contextState: options.state,
			});
		}
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
		parseOptions: ProviderChoiceParseOptions & { readonly consume: "explicit" },
	): Promise<ProviderChoiceExplicitParseResult>;
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
	):
		| ProviderChoiceTokenPayload
		| ProviderChoiceExplicitParseResult
		| Promise<ProviderChoiceTokenPayload | ProviderChoiceExplicitParseResult> {
		const consumeMode = parseOptions.consume ?? "never";
		const wordStateKey = parseWordChoiceStateKey({
			token: parseOptions.token,
			prefix: parseOptions.prefix,
		});
		if (wordStateKey) {
			const parsed = parseWordServerStoredChoice({
				stateKey: wordStateKey,
				parseOptions,
				contextState: options.state,
				providerId: options.providerId,
				request: options.request,
				credential: options.credential,
				resolveBindingKeys: () =>
					deriveManagedChoiceKeys({
						masterSecret: resolveMasterSecret(),
						providerId: options.providerId,
						purpose: parseOptions.purpose,
						kid,
					}),
				onConsume: (result) =>
					emitChoiceTelemetry(options.onTelemetry, {
						providerId: options.providerId,
						purpose: parseOptions.purpose,
						operation: "consume",
						format: "word",
						outcome: "success",
						consumeMode,
						consumed: result.status === "consumed",
						replay: result.status === "already-consumed",
					}),
			});
			return observeChoiceParse<ProviderChoiceTokenPayload | ProviderChoiceExplicitParseResult>(
				parsed,
				{
					onTelemetry: options.onTelemetry,
					providerId: options.providerId,
					purpose: parseOptions.purpose,
					format: "word",
					consumeMode,
				},
			);
		}

		// Inline choices continue to use the encrypted envelope. A structurally
		// valid word token returns above, so lookup, expiry, consumption, and
		// binding failures can never enter this branch.
		try {
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
				throw wordChoiceNotFoundError();
			}
			const payload = envelope.payload;
			const parsed =
				consumeMode === "explicit"
					? Promise.resolve(payload).then((resolvedPayload) =>
							createInlineExplicitParseResult({
								payload: resolvedPayload,
								replayKey: digestChoiceReplayKey(parseOptions.token),
								onConsume: () =>
									emitChoiceTelemetry(options.onTelemetry, {
										providerId: options.providerId,
										purpose: parseOptions.purpose,
										operation: "consume",
										format: "legacy",
										outcome: "unsupported",
										consumeMode,
										consumed: false,
										replay: false,
									}),
							}),
						)
					: payload;
			return observeChoiceParse<ProviderChoiceTokenPayload | ProviderChoiceExplicitParseResult>(
				parsed,
				{
					onTelemetry: options.onTelemetry,
					providerId: options.providerId,
					purpose: parseOptions.purpose,
					format: "legacy",
					consumeMode,
				},
			);
		} catch (error) {
			emitChoiceParseFailure(options.onTelemetry, error, {
				providerId: options.providerId,
				purpose: parseOptions.purpose,
				format: "legacy",
				consumeMode,
			});
			throw error;
		}
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

type ChoiceParseTelemetryBase = {
	readonly onTelemetry?: (event: ProviderChoiceTelemetryEvent) => void;
	readonly providerId: string;
	readonly purpose: string;
	readonly format: "word" | "legacy";
	readonly consumeMode: ProviderChoiceConsumeMode;
};

function observeChoiceParse<T>(
	result: T | Promise<T>,
	base: ChoiceParseTelemetryBase,
): T | Promise<T> {
	if (result instanceof Promise) {
		return result.then(
			(value) => {
				emitChoiceParseSuccess(base, value);
				return value;
			},
			(error: unknown) => {
				emitChoiceParseFailure(base.onTelemetry, error, base);
				throw error;
			},
		);
	}
	emitChoiceParseSuccess(base, result);
	return result;
}

function emitChoiceParseSuccess(base: ChoiceParseTelemetryBase, result: unknown): void {
	const replay = isConsumedChoiceReplay(result);
	emitChoiceTelemetry(base.onTelemetry, {
		providerId: base.providerId,
		purpose: base.purpose,
		operation: "parse",
		format: base.format,
		outcome: "success",
		consumeMode: base.consumeMode,
		consumed: replay || (base.format === "word" && base.consumeMode === "on-parse"),
		replay,
	});
}

function isConsumedChoiceReplay(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		"status" in value &&
		value.status === "consumed" &&
		"replayKey" in value &&
		typeof value.replayKey === "string"
	);
}

function emitChoiceParseFailure(
	onTelemetry: CreateProviderChoiceContextOptions["onTelemetry"],
	error: unknown,
	base: Omit<ChoiceParseTelemetryBase, "onTelemetry">,
): void {
	const outcome =
		error instanceof ProviderChoiceTokenError
			? base.format === "word" && error.message === WORD_CHOICE_NOT_FOUND_MESSAGE
				? "not-found"
				: "invalid"
			: "error";
	emitChoiceTelemetry(onTelemetry, {
		providerId: base.providerId,
		purpose: base.purpose,
		operation: "parse",
		format: base.format,
		outcome,
		consumeMode: base.consumeMode,
		consumed: false,
		replay: false,
	});
}

function emitChoiceTelemetry(
	onTelemetry: CreateProviderChoiceContextOptions["onTelemetry"],
	event: ProviderChoiceTelemetryEvent,
): void {
	try {
		onTelemetry?.(event);
	} catch {
		// Observability must never change provider token semantics.
	}
}

function createInlineExplicitParseResult(options: {
	readonly payload: ProviderChoiceTokenPayload;
	readonly replayKey: string;
	readonly onConsume: () => void;
}): ProviderChoiceExplicitParseResult {
	return {
		status: "active",
		payload: options.payload,
		replayKey: options.replayKey,
		consume: async () => {
			options.onConsume();
			return { status: "unsupported" };
		},
	};
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

async function issueWordServerStoredChoice<TPayload extends ProviderChoiceTokenPayload>(options: {
	readonly baseEnvelope: Omit<ManagedChoiceEnvelope, "payload">;
	readonly issueOptions: ProviderChoiceIssueOptions<TPayload>;
	readonly storage: ServerProviderChoiceStorageOptions;
	readonly contextState?: ProviderRuntimeState;
}): Promise<string> {
	const serializedPayload = serializeChoicePayload(options.issueOptions.payload);
	const payloadDigest = digestChoicePayload(serializedPayload);
	const namespace = resolveChoiceStateNamespace({
		storage: options.storage,
		contextState: options.contextState,
		ttlMs: options.issueOptions.ttlMs,
	});
	const wordCount =
		options.issueOptions.strength === "high" ? HIGH_CHOICE_WORD_COUNT : STANDARD_CHOICE_WORD_COUNT;
	for (let attempt = 0; attempt < SERVER_STORED_CHOICE_ISSUE_ATTEMPTS; attempt += 1) {
		const stateKey = generateChoiceWordSequence(wordCount);
		const token = `${options.issueOptions.prefix}${stateKey}`;
		const record: ServerStoredChoiceRecord = {
			v: SERVER_STORED_CHOICE_RECORD_VERSION,
			storage: "server",
			status: "active",
			provider_id: options.baseEnvelope.provider_id,
			purpose: options.baseEnvelope.purpose,
			issued_at_ms: options.baseEnvelope.issued_at_ms,
			ttl_ms: options.baseEnvelope.ttl_ms,
			binding: options.baseEnvelope.binding,
			prefix: options.issueOptions.prefix,
			payload: options.issueOptions.payload,
			payload_digest: payloadDigest,
			replay_key: digestChoiceReplayKey(token),
		};
		const valueBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
		if (valueBytes > options.storage.maxValueBytes) {
			throw new ProviderError("Provider choice payload exceeds state storage policy.", {
				code: "CHOICE_STATE_PAYLOAD_TOO_LARGE",
				category: "input_validation",
				retryable: false,
				details: {
					maxValueBytes: options.storage.maxValueBytes,
					valueBytes,
				},
			});
		}
		const result = await namespace.compareAndSet(optionsStateKey(stateKey), 0, record, {
			ttl: stateTtl(options.storage, options.issueOptions.ttlMs),
		});
		if (result.ok) return token;
	}
	throw new ProviderError("Provider choice state storage is not available.", {
		code: "CHOICE_STATE_UNAVAILABLE",
		category: "internal_error",
		retryable: false,
	});
}

async function parseWordServerStoredChoice(options: {
	readonly stateKey: string;
	readonly parseOptions: ProviderChoiceParseOptions;
	readonly contextState?: ProviderRuntimeState;
	readonly providerId: string;
	readonly request?: ProviderRequestContext;
	readonly credential?: CredentialContext;
	readonly resolveBindingKeys: () => ManagedChoiceKeys;
	readonly onConsume: (result: ProviderChoiceConsumeResult) => void;
}): Promise<ProviderChoiceTokenPayload | ProviderChoiceExplicitParseResult> {
	const storage = resolveParseStorage(options.parseOptions.storage);
	const namespace = resolveChoiceStateNamespace({
		storage,
		contextState: options.contextState,
		ttlMs: options.parseOptions.ttlMs,
	});
	let stored: StateValue<ServerStoredChoiceRecord> | null;
	try {
		stored = await namespace.get<ServerStoredChoiceRecord>(optionsStateKey(options.stateKey));
	} catch (error) {
		if (isProviderError(error)) throw error;
		throw wordChoiceNotFoundError();
	}
	if (!stored || !isServerStoredChoiceRecord(stored.value)) {
		throw wordChoiceNotFoundError();
	}

	const record = stored.value;
	const expectedReplayKey = digestChoiceReplayKey(
		`${options.parseOptions.prefix}${options.stateKey}`,
	);
	try {
		if (
			record.provider_id !== options.providerId ||
			record.purpose !== options.parseOptions.purpose ||
			record.prefix !== options.parseOptions.prefix
		) {
			throw wordChoiceNotFoundError();
		}
		assertPayloadDigestMatches({
			actual: digestChoicePayload(serializeChoicePayload(record.payload)),
			expected: record.payload_digest,
		});
		assertPayloadDigestMatches({ actual: expectedReplayKey, expected: record.replay_key });
		assertWordChoiceBindingMatches({
			actual: record.binding,
			requested: options.parseOptions.bind,
			request: options.request,
			credential: options.credential,
			resolveKeys: options.resolveBindingKeys,
		});
	} catch (error) {
		if (
			error instanceof ProviderChoiceTokenError ||
			(isProviderError(error) && error.code === "CHOICE_CONTEXT_REQUIRED")
		) {
			throw wordChoiceNotFoundError();
		}
		throw error;
	}
	// Freshness is classified last, reachable only after every identity,
	// integrity, and binding check above has passed (ADR 0006, amended
	// 2026-08-20): a caller that proved the record's binding may observe the
	// canonical stale error, while an unbound record keeps the collapsed
	// not-found error so expiry never becomes an existence signal for
	// guessable tokens.
	try {
		assertFreshProviderChoiceIssuedAt(record.issued_at_ms, {
			ttlMs:
				options.parseOptions.ttlMs != null
					? Math.min(options.parseOptions.ttlMs, record.ttl_ms)
					: record.ttl_ms,
			nowMs: options.parseOptions.nowMs,
			futureToleranceMs: options.parseOptions.futureToleranceMs,
		});
	} catch (error) {
		const recordIsBound = Boolean(
			record.binding?.connection_hash || record.binding?.credential_hash,
		);
		if (recordIsBound && error instanceof ProviderChoiceTokenError && error.reason === "stale") {
			throw error;
		}
		if (error instanceof ProviderChoiceTokenError) throw wordChoiceNotFoundError();
		throw error;
	}

	const consumeMode = options.parseOptions.consume ?? "never";
	if (record.status === "consumed") {
		if (consumeMode === "explicit") {
			return { status: "consumed", replayKey: record.replay_key };
		}
		throw wordChoiceNotFoundError();
	}
	if (consumeMode === "never") return record.payload;
	if (consumeMode === "explicit") {
		return {
			status: "active",
			payload: record.payload,
			replayKey: record.replay_key,
			consume: async () => {
				const result = await consumeWordServerStoredChoice({
					stateKey: options.stateKey,
					stored,
					record,
					storage,
					contextState: options.contextState,
				});
				options.onConsume(result);
				return result;
			},
		};
	}
	const consumed = await consumeWordServerStoredChoice({
		stateKey: options.stateKey,
		stored,
		record,
		storage,
		contextState: options.contextState,
	});
	if (consumed.status !== "consumed") throw wordChoiceNotFoundError();
	return record.payload;
}

async function consumeWordServerStoredChoice(options: {
	readonly stateKey: string;
	readonly stored: StateValue<ServerStoredChoiceRecord>;
	readonly record: ServerStoredChoiceRecord;
	readonly storage: ServerProviderChoiceStorageOptions;
	readonly contextState?: ProviderRuntimeState;
}): Promise<ProviderChoiceConsumeResult> {
	const namespace = resolveChoiceStateNamespace({
		storage: options.storage,
		contextState: options.contextState,
		ttlMs: options.record.ttl_ms,
	});
	try {
		const consumed = await namespace.compareAndSet(
			optionsStateKey(options.stateKey),
			options.stored.version,
			{ ...options.record, status: "consumed" } satisfies ServerStoredChoiceRecord,
			{ ttl: remainingStateTtl(options.stored.expiresAt) },
		);
		if (consumed.ok) return { status: "consumed" };
		if (
			consumed.current &&
			isServerStoredChoiceRecord(consumed.current.value) &&
			consumed.current.value.status === "consumed" &&
			consumed.current.value.replay_key === options.record.replay_key
		) {
			return { status: "already-consumed" };
		}
		throw wordChoiceNotFoundError();
	} catch (error) {
		if (isProviderError(error)) throw error;
		if (error instanceof ProviderChoiceTokenError) throw error;
		throw wordChoiceNotFoundError();
	}
}

function generateChoiceWordSequence(wordCount: number): string {
	return Array.from({ length: wordCount }, () =>
		choiceWordAt(randomInt(CHOICE_WORDLIST_SIZE)),
	).join("-");
}

function parseWordChoiceStateKey(options: {
	readonly token: string;
	readonly prefix: string;
}): string | null {
	if (!options.token.startsWith(options.prefix)) return null;
	const body = options.token.slice(options.prefix.length);
	// The official list contains one hyphenated entry (`yo-yo`), so structural
	// recognition uses dictionary-aware segmentation instead of assuming every
	// hyphen is a word boundary.
	if (!/^[a-z]+(?:-[a-z]+){3,9}$/.test(body)) return null;
	const segments = body.split("-");
	if (
		!canSegmentChoiceWords(segments, 0, STANDARD_CHOICE_WORD_COUNT) &&
		!canSegmentChoiceWords(segments, 0, HIGH_CHOICE_WORD_COUNT)
	) {
		return null;
	}
	return body;
}

function canSegmentChoiceWords(
	segments: readonly string[],
	segmentIndex: number,
	wordsRemaining: number,
): boolean {
	if (wordsRemaining === 0) return segmentIndex === segments.length;
	const segmentsRemaining = segments.length - segmentIndex;
	if (segmentsRemaining < wordsRemaining) return false;
	for (let end = segmentIndex + 1; end <= segments.length - (wordsRemaining - 1); end += 1) {
		const candidate = segments.slice(segmentIndex, end).join("-");
		if (candidate.length > 10) break;
		if (isChoiceWord(candidate) && canSegmentChoiceWords(segments, end, wordsRemaining - 1)) {
			return true;
		}
	}
	return false;
}

function isServerStoredChoiceRecord(value: unknown): value is ServerStoredChoiceRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (
		"v" in value &&
		value.v === SERVER_STORED_CHOICE_RECORD_VERSION &&
		"storage" in value &&
		value.storage === "server" &&
		"status" in value &&
		(value.status === "active" || value.status === "consumed") &&
		"provider_id" in value &&
		typeof value.provider_id === "string" &&
		"purpose" in value &&
		typeof value.purpose === "string" &&
		"issued_at_ms" in value &&
		typeof value.issued_at_ms === "number" &&
		"ttl_ms" in value &&
		typeof value.ttl_ms === "number" &&
		(!("binding" in value) || value.binding === undefined || isChoiceBinding(value.binding)) &&
		"prefix" in value &&
		typeof value.prefix === "string" &&
		"payload" in value &&
		isChoicePayload(value.payload) &&
		"payload_digest" in value &&
		typeof value.payload_digest === "string" &&
		"replay_key" in value &&
		typeof value.replay_key === "string"
	);
}

function wordChoiceNotFoundError(): ProviderChoiceTokenError {
	return new ProviderChoiceTokenError("invalid_payload", WORD_CHOICE_NOT_FOUND_MESSAGE);
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

function remainingStateTtl(expiresAt: string): ProviderStateDurationString {
	const remainingMs = Date.parse(expiresAt) - Date.now();
	return `${Number.isFinite(remainingMs) ? Math.max(1, Math.floor(remainingMs)) : 1}ms`;
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

function digestChoiceReplayKey(token: string): string {
	return createHash("sha256").update(token).digest("hex");
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

function hasRequestedChoiceBinding(options?: ProviderChoiceBindingOptions): boolean {
	return options?.connection === true || Boolean(options?.credentialKeys?.length);
}

function assertWordChoiceBindingMatches(options: {
	readonly actual: ManagedChoiceEnvelope["binding"];
	readonly requested?: ProviderChoiceBindingOptions;
	readonly request?: ProviderRequestContext;
	readonly credential?: CredentialContext;
	readonly resolveKeys: () => ManagedChoiceKeys;
}): void {
	const hasStoredBinding = Boolean(
		options.actual?.connection_hash || options.actual?.credential_hash,
	);
	const hasRequestedBinding = hasRequestedChoiceBinding(options.requested);
	if (!hasStoredBinding && !hasRequestedBinding) return;
	if (hasStoredBinding !== hasRequestedBinding) throw wordChoiceNotFoundError();
	assertChoiceBindingMatches({
		actual: options.actual,
		expected: createChoiceBinding({
			keys: options.resolveKeys(),
			options: options.requested,
			request: options.request,
			credential: options.credential,
			required: true,
		}),
	});
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
