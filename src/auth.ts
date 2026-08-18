import { AuthError, ProviderError } from "./errors.js";
import {
	declarationInvalidError,
	DECLARATION_RULE_IDS,
	type DeclarationViolation,
} from "./declaration-validation.js";
import type {
	AuthAbortData,
	AuthConfig,
	AuthFlowTerminalContext,
	AuthSafeData,
	AuthSafeJson,
	AuthTurn,
	ContextDeclaration,
	CredentialDeclaration,
	FlowContext,
	ProviderLocaleKeyInput,
} from "./types.js";

const CREDENTIALS_AUTH_CHALLENGE_CONTEXT_KEY = "__credentialsAuthChallenge";
const DEFAULT_COMPLETE_TURN_ID = "auth.complete";
const DEFAULT_ABORT_TURN_ID = "auth.abort";
const DEFAULT_FORM_TURN_ID = "auth.form";
const DEFAULT_POLL_TURN_ID = "auth.poll";
const SENSITIVE_ABORT_DATA_KEY_PATTERN =
	/(authorization|cookie|credential|header|html|password|secret|session|token|apikey)/i;

function normalizedAuthDataKey(key: string): string {
	return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isPlainAuthJsonObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isSensitiveAuthDataKey(key: string): boolean {
	return SENSITIVE_ABORT_DATA_KEY_PATTERN.test(normalizedAuthDataKey(key));
}

export type CredentialsAuthFieldType = "string" | "email" | "password" | "otp";

export interface CredentialsAuthField {
	type?: CredentialsAuthFieldType;
	labelKey?: ProviderLocaleKeyInput;
	descriptionKey?: ProviderLocaleKeyInput;
	placeholderKey?: ProviderLocaleKeyInput;
	required?: boolean;
	/** Marks field values as secret UI/input material, for example passwords or OTPs. */
	sensitive?: boolean;
}

export type CredentialsAuthFields = Record<string, CredentialsAuthField>;

export type CredentialsAuthInput<TFields extends CredentialsAuthFields> = {
	[K in keyof TFields]: string;
};

export type CredentialsAuthCredential<TCredentialKeys extends readonly string[]> = {
	[K in TCredentialKeys[number]]: string;
};

function assertSafeAuthJson(value: AuthSafeJson, path: string): void {
	if (value === null) return;
	if (typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new AuthError(`Auth abort ${path} must be a finite number`, {
			code: "auth_abort_unsafe_data",
		});
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			assertSafeAuthJson(item, `${path}[${index}]`);
		}
		return;
	}
	if (value instanceof Error) {
		throw new AuthError(`Auth abort ${path} must not include Error objects`, {
			code: "auth_abort_unsafe_data",
		});
	}
	if (typeof value !== "object") {
		throw new AuthError(`Auth abort ${path} must be JSON-safe`, {
			code: "auth_abort_unsafe_data",
		});
	}
	if (!isPlainAuthJsonObject(value)) {
		throw new AuthError(`Auth abort ${path} must be a plain JSON object`, {
			code: "auth_abort_unsafe_data",
		});
	}
	for (const [key, item] of Object.entries(value)) {
		if (isSensitiveAuthDataKey(key)) {
			throw new AuthError(`Auth abort ${path}.${key} must not include secrets`, {
				code: "auth_abort_unsafe_data",
			});
		}
		assertSafeAuthJson(item, `${path}.${key}`);
	}
}

function assertSafeAuthData(data: AuthSafeData, path: string): void {
	assertSafeAuthJson(data, path);
}

function authTurnBase(options: {
	turnId: string | undefined;
	defaultTurnId: string;
	expiresAt?: string;
}): Pick<AuthTurn, "turnId" | "expiresAt"> {
	return {
		turnId: options.turnId ?? options.defaultTurnId,
		...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
	};
}

function abortData(options: {
	code: string;
	message?: string;
	retry?: AuthAbortData["retry"];
	actionHint?: AuthSafeJson;
	fieldErrors?: { readonly [field: string]: string };
	data?: AuthSafeData;
}): AuthAbortData {
	if (options.actionHint !== undefined) {
		assertSafeAuthJson(options.actionHint, "actionHint");
	}
	if (options.data !== undefined) {
		assertSafeAuthData(options.data, "data");
	}
	return {
		code: options.code,
		...(options.message ? { message: options.message } : {}),
		...(options.retry ? { retry: options.retry } : {}),
		...(options.actionHint !== undefined ? { actionHint: options.actionHint } : {}),
		...(options.fieldErrors ? { fieldErrors: options.fieldErrors } : {}),
		...(options.data ? { details: options.data } : {}),
	};
}

export function createAuthFlowHelpers(
	options: { readonly signal?: AbortSignal; readonly deadline?: string } = {},
): AuthFlowTerminalContext {
	return {
		...(options.signal ? { signal: options.signal } : {}),
		...(options.deadline ? { deadline: options.deadline } : {}),
		complete({ credential, metadata, data, turnId, expiresAt }) {
			return {
				kind: "complete",
				...authTurnBase({ turnId, defaultTurnId: DEFAULT_COMPLETE_TURN_ID, expiresAt }),
				data: {
					...(data ?? {}),
					credential,
					...(metadata ? { metadata } : {}),
				},
			};
		},
		abort({ code, message, retry, actionHint, fieldErrors, data, turnId, expiresAt }) {
			return {
				kind: "abort",
				...authTurnBase({ turnId, defaultTurnId: DEFAULT_ABORT_TURN_ID, expiresAt }),
				data: abortData({
					code,
					message,
					retry,
					actionHint,
					fieldErrors,
					data,
				}),
			};
		},
		nextForm(options) {
			return {
				kind: "form",
				...authTurnBase({
					turnId: options.turnId,
					defaultTurnId: DEFAULT_FORM_TURN_ID,
					expiresAt: options.expiresAt,
				}),
				...(options.hintKey ? { hintKey: options.hintKey } : {}),
				...(options.timing ? { timing: options.timing } : {}),
				...(options.data ? { data: options.data } : {}),
				expectedInput: options.expectedInput ?? expectedInputFromFields(options.fields ?? {}),
			};
		},
		nextPoll(options = {}) {
			return {
				kind: "poll",
				...authTurnBase({
					turnId: options.turnId,
					defaultTurnId: DEFAULT_POLL_TURN_ID,
					expiresAt: options.expiresAt,
				}),
				...(options.hintKey ? { hintKey: options.hintKey } : {}),
				...(options.timing ? { timing: options.timing } : {}),
				...(options.data ? { data: options.data } : {}),
			};
		},
	};
}

export class AuthAbortError extends AuthError {
	readonly turn: AuthTurn;

	constructor(options: Parameters<AuthFlowTerminalContext["abort"]>[0]) {
		super(options.message ?? options.code, {
			code: options.code,
			retryable: options.retry === "retry",
		});
		this.name = "AuthAbortError";
		this.turn = createAuthFlowHelpers().abort(options);
	}
}

export interface CredentialsAuthCompleteResult<TCredentialKeys extends readonly string[]> {
	credential: CredentialsAuthCredential<TCredentialKeys>;
	/** Additional non-credential auth-flow data to return alongside credential. */
	data?: Record<string, unknown>;
	turnId?: string;
	expiresAt?: string;
}

export interface CredentialsAuthChallengeRequest<TChallengeId extends string = string> {
	kind: "challenge";
	challengeId: TChallengeId;
	state?: Record<string, unknown>;
	turnId?: string;
	hintKey?: ProviderLocaleKeyInput;
	expiresAt?: string;
	data?: Record<string, unknown>;
	timing?: AuthTurn["timing"];
}

export type CredentialsAuthLoginResult<
	TCredentialKeys extends readonly string[],
	TChallengeId extends string = string,
> = CredentialsAuthCompleteResult<TCredentialKeys> | CredentialsAuthChallengeRequest<TChallengeId>;

export interface CredentialsAuthChallengeDefinition<
	TFields extends CredentialsAuthFields,
	TCredentialKeys extends readonly string[],
	TChallengeId extends string,
> {
	fields?: TFields;
	hintKey?: ProviderLocaleKeyInput;
	turnId?: string;
	retryTurnId?: string;
	pendingTurnId?: string;
	timing?: AuthTurn["timing"];
	verify?: (
		ctx: FlowContext,
		input: CredentialsAuthInput<TFields>,
		state: Record<string, unknown>,
	) =>
		| CredentialsAuthLoginResult<TCredentialKeys, TChallengeId>
		| Promise<CredentialsAuthLoginResult<TCredentialKeys, TChallengeId>>;
	poll?: (
		ctx: FlowContext,
		state: Record<string, unknown>,
	) =>
		| CredentialsAuthLoginResult<TCredentialKeys, TChallengeId>
		| null
		| Promise<CredentialsAuthLoginResult<TCredentialKeys, TChallengeId> | null>;
}

export interface DefineCredentialsAuthOptions<
	TFields extends CredentialsAuthFields,
	TCredentialKeys extends readonly string[],
	TChallenges extends Record<
		string,
		CredentialsAuthChallengeDefinition<
			CredentialsAuthFields,
			TCredentialKeys,
			keyof TChallenges & string
		>
	> = Record<
		string,
		CredentialsAuthChallengeDefinition<CredentialsAuthFields, TCredentialKeys, string>
	>,
> {
	fields: TFields;
	credentialKeys: TCredentialKeys;
	storesReusableSecret?: boolean;
	justification?: string;
	hintKey?: ProviderLocaleKeyInput;
	startTurnId?: string;
	retryTurnId?: string;
	completeTurnId?: string;
	challenges?: TChallenges;
	/** Extra auth-flow context keys used by custom login/challenge code. */
	contextKeys?: readonly string[];
	login(
		ctx: FlowContext,
		input: CredentialsAuthInput<TFields>,
	):
		| CredentialsAuthLoginResult<TCredentialKeys, keyof TChallenges & string>
		| Promise<CredentialsAuthLoginResult<TCredentialKeys, keyof TChallenges & string>>;
	/**
	 * Optional re-mint of an expired session from the stored credential, wired
	 * to `auth.flow.refresh`.
	 *
	 * Credential-auth upstreams routinely invalidate a session well before the
	 * `expiresAt` the provider advertised, which leaves every operation failing
	 * with a reauth error until a human repeats the whole interactive login.
	 * Implement this to re-establish the session from what is already stored on
	 * the connection; the result is resolved exactly like `login`, so it may
	 * also raise a challenge when the upstream demands one. Omit it when the
	 * upstream has no non-interactive path and re-authentication genuinely
	 * requires the user.
	 */
	refresh?(
		ctx: FlowContext,
		input: Partial<CredentialsAuthInput<TFields>>,
	):
		| CredentialsAuthLoginResult<TCredentialKeys, keyof TChallenges & string>
		| Promise<CredentialsAuthLoginResult<TCredentialKeys, keyof TChallenges & string>>;
}

export interface DefinedCredentialsAuth {
	auth: AuthConfig;
	credential: CredentialDeclaration;
	context: ContextDeclaration;
}

interface PendingCredentialsAuthChallenge {
	challengeId: string;
	state: Record<string, unknown>;
	turnId?: string;
	hintKey?: ProviderLocaleKeyInput;
	expiresAt?: string;
	data?: Record<string, unknown>;
	timing?: AuthTurn["timing"];
}

export function credentialsAuthChallenge<TChallengeId extends string>(
	challengeId: TChallengeId,
	options: Omit<CredentialsAuthChallengeRequest<TChallengeId>, "kind" | "challengeId"> = {},
): CredentialsAuthChallengeRequest<TChallengeId> {
	return {
		kind: "challenge",
		challengeId,
		...options,
	};
}

function expectedInputFromFields(fields: CredentialsAuthFields): Record<string, unknown> {
	return {
		type: "object",
		properties: Object.fromEntries(
			Object.entries(fields).map(([name, field]) => [
				name,
				{
					type: "string",
					...(field.type === "email" ? { format: "email" } : {}),
					...(field.type === "password" ? { format: "password" } : {}),
					...(field.type === "otp" ? { format: "otp" } : {}),
					...(field.labelKey ? { nameKey: field.labelKey } : {}),
					...(field.descriptionKey ? { descriptionKey: field.descriptionKey } : {}),
					...(field.placeholderKey ? { placeholderKey: field.placeholderKey } : {}),
					...(field.sensitive || field.type === "password" || field.type === "otp"
						? { sensitive: true }
						: {}),
				},
			]),
		),
		required: Object.entries(fields)
			.filter(([, field]) => field.required !== false)
			.map(([name]) => name),
	};
}

function collectMissingFields(
	fields: CredentialsAuthFields,
	input: Record<string, unknown> | undefined,
): string[] {
	return Object.entries(fields)
		.filter(([, field]) => field.required !== false)
		.map(([name]) => name)
		.filter((name) => {
			const value = input?.[name];
			return typeof value !== "string" || value.trim().length === 0;
		});
}

function normalizeInput<TFields extends CredentialsAuthFields>(
	fields: TFields,
	input: Record<string, unknown> | undefined,
): CredentialsAuthInput<TFields> {
	const result: Record<string, string> = {};
	for (const name of Object.keys(fields)) {
		const value = input?.[name];
		result[name] = typeof value === "string" ? value : "";
	}
	return result as CredentialsAuthInput<TFields>;
}

/**
 * Refresh variant of {@link normalizeInput}. `login` coerces every declared
 * field to a string because the interactive turn has already enforced that they
 * are present; refresh runs with no user present, so an absent field is omitted
 * rather than turned into an empty string. That keeps "the user did not supply
 * this" distinguishable from "the user supplied an empty value".
 */
function normalizePartialInput<TFields extends CredentialsAuthFields>(
	fields: TFields,
	input: Record<string, unknown> | undefined,
): Partial<CredentialsAuthInput<TFields>> {
	const result: Record<string, string> = {};
	for (const name of Object.keys(fields)) {
		const value = input?.[name];
		if (typeof value === "string") {
			result[name] = value;
		}
	}
	return result as Partial<CredentialsAuthInput<TFields>>;
}

function assertCredentialKeys<TCredentialKeys extends readonly string[]>(
	credentialKeys: TCredentialKeys,
	credential: Record<string, unknown>,
): asserts credential is CredentialsAuthCredential<TCredentialKeys> {
	const missing = credentialKeys.filter((key) => {
		const value = credential[key];
		return typeof value !== "string" || value.length === 0;
	});
	if (missing.length > 0) {
		throw new ProviderError(
			`Credentials auth login completed without required credential key(s): ${missing.join(", ")}`,
			{
				code: "credentials_auth_missing_credential_keys",
				fix: "Return every credentialKeys entry from defineCredentialsAuth({ login }) as result.credential. Gateway persists only auth.flow complete data.credential into the connection.",
			},
		);
	}
}

function getPendingChallenge(ctx: FlowContext): PendingCredentialsAuthChallenge | null {
	const value = ctx.context.get(CREDENTIALS_AUTH_CHALLENGE_CONTEXT_KEY);
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.challengeId !== "string") return null;
	const state =
		record.state && typeof record.state === "object" && !Array.isArray(record.state)
			? (record.state as Record<string, unknown>)
			: {};
	return {
		challengeId: record.challengeId,
		state,
		...(typeof record.turnId === "string" ? { turnId: record.turnId } : {}),
		...(typeof record.hintKey === "string" ? { hintKey: record.hintKey } : {}),
		...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
		...(record.data && typeof record.data === "object" && !Array.isArray(record.data)
			? { data: record.data as Record<string, unknown> }
			: {}),
		...(record.timing && typeof record.timing === "object" && !Array.isArray(record.timing)
			? { timing: record.timing as AuthTurn["timing"] }
			: {}),
	};
}

function setPendingChallenge(ctx: FlowContext, challenge: PendingCredentialsAuthChallenge): void {
	ctx.context.set(CREDENTIALS_AUTH_CHALLENGE_CONTEXT_KEY, challenge);
}

function clearPendingChallenge(ctx: FlowContext): void {
	ctx.context.set(CREDENTIALS_AUTH_CHALLENGE_CONTEXT_KEY, null);
}

function pendingToChallengeRequest(
	pending: PendingCredentialsAuthChallenge,
): CredentialsAuthChallengeRequest<string> {
	return {
		kind: "challenge",
		challengeId: pending.challengeId,
		state: pending.state,
		...(pending.turnId ? { turnId: pending.turnId } : {}),
		...(pending.hintKey ? { hintKey: pending.hintKey } : {}),
		...(pending.expiresAt ? { expiresAt: pending.expiresAt } : {}),
		...(pending.data ? { data: pending.data } : {}),
		...(pending.timing ? { timing: pending.timing } : {}),
	};
}

function retryTurn(
	expectedInput: Record<string, unknown>,
	missing: readonly string[],
	retryTurnId: string,
): AuthTurn {
	return {
		kind: "retry",
		turnId: retryTurnId,
		expectedInput,
		data: {
			fieldErrors: Object.fromEntries(missing.map((name) => [name, "Required"])),
			fieldErrorKeys: Object.fromEntries(
				missing.map((name) => [name, "auth.credentials.fieldRequired"]),
			),
		},
	};
}

function isChallengeRequest(
	result: CredentialsAuthLoginResult<readonly string[], string>,
): result is CredentialsAuthChallengeRequest<string> {
	return "kind" in result && result.kind === "challenge";
}

function completeTurn<TCredentialKeys extends readonly string[]>(
	credentialKeys: TCredentialKeys,
	result: CredentialsAuthCompleteResult<TCredentialKeys>,
	defaultTurnId: string,
): AuthTurn {
	if (
		!result.credential ||
		typeof result.credential !== "object" ||
		Array.isArray(result.credential)
	) {
		throw new ProviderError("Credentials auth login completed without a credential object", {
			code: "credentials_auth_missing_credential",
			fix: "Return { credential: { ... } } from defineCredentialsAuth handlers. Gateway persists only auth.flow complete data.credential into the connection.",
		});
	}
	assertCredentialKeys(credentialKeys, result.credential as Record<string, unknown>);
	return {
		kind: "complete",
		turnId: result.turnId ?? defaultTurnId,
		...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
		data: {
			...(result.data ?? {}),
			credential: result.credential,
		},
	};
}

function challengeTurn(
	definition: CredentialsAuthChallengeDefinition<CredentialsAuthFields, readonly string[], string>,
	request: CredentialsAuthChallengeRequest<string>,
): AuthTurn {
	const expectedInput = definition.fields ? expectedInputFromFields(definition.fields) : undefined;
	return {
		kind: expectedInput ? "form" : "pending",
		turnId: request.turnId ?? definition.turnId ?? `credentials.${request.challengeId}`,
		...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
		...((request.hintKey ?? definition.hintKey)
			? { hintKey: request.hintKey ?? definition.hintKey }
			: {}),
		...((request.timing ?? definition.timing)
			? { timing: request.timing ?? definition.timing }
			: {}),
		...(expectedInput ? { expectedInput } : {}),
		data: {
			...(request.data ?? {}),
			challengeId: request.challengeId,
		},
	};
}

async function resolveAuthResult<TCredentialKeys extends readonly string[]>(
	ctx: FlowContext,
	credentialKeys: TCredentialKeys,
	challenges: Record<
		string,
		CredentialsAuthChallengeDefinition<CredentialsAuthFields, TCredentialKeys, string>
	>,
	result: CredentialsAuthLoginResult<TCredentialKeys, string>,
	completeTurnId: string,
): Promise<AuthTurn> {
	if (!result || typeof result !== "object") {
		throw new AuthError("Credentials auth login did not return a result", {
			code: "credentials_auth_invalid_login_result",
			fix: "Return { credential: { ... } } or credentialsAuthChallenge(...) from defineCredentialsAuth handlers.",
		});
	}
	if (!isChallengeRequest(result)) {
		clearPendingChallenge(ctx);
		return completeTurn(credentialKeys, result, completeTurnId);
	}

	const definition = challenges[result.challengeId];
	if (!definition) {
		throw new ProviderError(
			`Credentials auth requested unknown challenge "${result.challengeId}"`,
			{
				code: "credentials_auth_unknown_challenge",
				fix: `Add challenges.${result.challengeId} to defineCredentialsAuth({ challenges }).`,
			},
		);
	}
	setPendingChallenge(ctx, {
		challengeId: result.challengeId,
		state: result.state ?? {},
		...(result.turnId ? { turnId: result.turnId } : {}),
		...(result.hintKey ? { hintKey: result.hintKey } : {}),
		...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
		...(result.data ? { data: result.data } : {}),
		...(result.timing ? { timing: result.timing } : {}),
	});
	return challengeTurn(definition, result);
}

async function continuePendingChallenge<TCredentialKeys extends readonly string[]>(
	ctx: FlowContext,
	credentialKeys: TCredentialKeys,
	challenges: Record<
		string,
		CredentialsAuthChallengeDefinition<CredentialsAuthFields, TCredentialKeys, string>
	>,
	pending: PendingCredentialsAuthChallenge,
	rawInput: Record<string, unknown> | undefined,
	completeTurnId: string,
): Promise<AuthTurn> {
	const definition = challenges[pending.challengeId];
	if (!definition) {
		throw new ProviderError(
			`Credentials auth has pending unknown challenge "${pending.challengeId}"`,
			{ code: "credentials_auth_unknown_pending_challenge" },
		);
	}
	if (!definition.fields || !definition.verify) {
		return challengeTurn(definition, pendingToChallengeRequest(pending));
	}

	const missing = collectMissingFields(definition.fields, rawInput);
	const expectedInput = expectedInputFromFields(definition.fields);
	if (missing.length > 0) {
		return retryTurn(
			expectedInput,
			missing,
			definition.retryTurnId ?? `credentials.${pending.challengeId}.retry`,
		);
	}
	const result = await definition.verify(
		ctx,
		normalizeInput(definition.fields, rawInput),
		pending.state,
	);
	return await resolveAuthResult(ctx, credentialKeys, challenges, result, completeTurnId);
}

async function pollPendingChallenge<TCredentialKeys extends readonly string[]>(
	ctx: FlowContext,
	credentialKeys: TCredentialKeys,
	challenges: Record<
		string,
		CredentialsAuthChallengeDefinition<CredentialsAuthFields, TCredentialKeys, string>
	>,
	pending: PendingCredentialsAuthChallenge,
	completeTurnId: string,
): Promise<AuthTurn> {
	const definition = challenges[pending.challengeId];
	if (!definition) {
		throw new ProviderError(
			`Credentials auth has pending unknown challenge "${pending.challengeId}"`,
			{ code: "credentials_auth_unknown_pending_challenge" },
		);
	}
	if (!definition.poll) {
		return challengeTurn(definition, pendingToChallengeRequest(pending));
	}
	const result = await definition.poll(ctx, pending.state);
	if (!result) {
		return {
			...challengeTurn(definition, pendingToChallengeRequest(pending)),
			turnId:
				definition.pendingTurnId ??
				definition.turnId ??
				`credentials.${pending.challengeId}.pending`,
		};
	}
	return await resolveAuthResult(ctx, credentialKeys, challenges, result, completeTurnId);
}

export function defineCredentialsAuth<
	TFields extends CredentialsAuthFields,
	TCredentialKeys extends readonly [string, ...string[]],
	TChallenges extends Record<
		string,
		CredentialsAuthChallengeDefinition<
			CredentialsAuthFields,
			TCredentialKeys,
			keyof TChallenges & string
		>
	> = Record<
		string,
		CredentialsAuthChallengeDefinition<CredentialsAuthFields, TCredentialKeys, string>
	>,
>(
	options: DefineCredentialsAuthOptions<TFields, TCredentialKeys, TChallenges>,
): DefinedCredentialsAuth {
	if (Object.keys(options.fields).length === 0) {
		throw new ProviderError("defineCredentialsAuth requires at least one field", {
			fix: 'Pass fields such as { email: { type: "email" }, password: { type: "password" } }.',
		});
	}

	const expectedInput = expectedInputFromFields(options.fields);
	const retryTurnId = options.retryTurnId ?? "credentials.retry";
	const completeTurnId = options.completeTurnId ?? "credentials.complete";
	const challenges = (options.challenges ?? {}) as Record<
		string,
		CredentialsAuthChallengeDefinition<CredentialsAuthFields, TCredentialKeys, string>
	>;
	validateCredentialsAuthChallenges(challenges);

	return {
		auth: {
			mode: "credentials",
			flow: {
				start: async () => ({
					kind: "form",
					turnId: options.startTurnId ?? "credentials.start",
					...(options.hintKey ? { hintKey: options.hintKey } : {}),
					expectedInput,
				}),
				continue: async (ctx, rawInput) => {
					const pending = getPendingChallenge(ctx);
					if (pending) {
						return await continuePendingChallenge(
							ctx,
							options.credentialKeys,
							challenges,
							pending,
							rawInput,
							completeTurnId,
						);
					}

					const missing = collectMissingFields(options.fields, rawInput);
					if (missing.length > 0) {
						return retryTurn(expectedInput, missing, retryTurnId);
					}

					const result = await options.login(ctx, normalizeInput(options.fields, rawInput));
					return await resolveAuthResult(
						ctx,
						options.credentialKeys,
						challenges,
						result,
						completeTurnId,
					);
				},
				poll: async (ctx) => {
					const pending = getPendingChallenge(ctx);
					if (!pending) {
						return {
							kind: "pending",
							turnId: "credentials.noPendingChallenge",
						};
					}
					return await pollPendingChallenge(
						ctx,
						options.credentialKeys,
						challenges,
						pending,
						completeTurnId,
					);
				},
				// Only advertise refresh when the provider implements it: the
				// protocol treats the hook's presence as "this connection can be
				// re-established without the user", and exposing a stub that
				// cannot actually re-mint would turn a recoverable expiry into a
				// silent failure.
				...(options.refresh
					? {
							refresh: async (ctx: FlowContext, rawInput?: Record<string, unknown>) => {
								// A pending challenge belongs to the interactive flow that
								// raised it; finish it there rather than restarting.
								const pending = getPendingChallenge(ctx);
								if (pending) {
									return await continuePendingChallenge(
										ctx,
										options.credentialKeys,
										challenges,
										pending,
										rawInput,
										completeTurnId,
									);
								}

								// Refresh runs without user input, so fields are optional
								// here — unlike `continue`, missing ones are not a retry.
								const result = await options.refresh!(
									ctx,
									normalizePartialInput(options.fields, rawInput),
								);
								return await resolveAuthResult(
									ctx,
									options.credentialKeys,
									challenges,
									result,
									completeTurnId,
								);
							},
						}
					: {}),
			},
		},
		credential: {
			keys: Array.from(options.credentialKeys),
			...(options.storesReusableSecret === undefined
				? {}
				: { storesReusableSecret: options.storesReusableSecret }),
			...(options.justification ? { justification: options.justification } : {}),
		},
		context: {
			keys: Array.from(
				new Set([CREDENTIALS_AUTH_CHALLENGE_CONTEXT_KEY, ...(options.contextKeys ?? [])]),
			),
		},
	};
}

function validateCredentialsAuthChallenges(
	challenges: Record<
		string,
		CredentialsAuthChallengeDefinition<CredentialsAuthFields, readonly string[], string>
	>,
): void {
	const violations: DeclarationViolation[] = [];
	for (const [challengeId, challenge] of Object.entries(challenges)) {
		const fieldCount =
			challenge.fields && typeof challenge.fields === "object"
				? Object.keys(challenge.fields).length
				: 0;
		const fieldsDeclared =
			challenge.fields !== undefined && challenge.fields !== null;
		const hasFields = fieldCount > 0;
		const hasVerify = typeof challenge.verify === "function";
		const hasPoll = typeof challenge.poll === "function";
		const isInteractive = hasFields && hasVerify && !hasPoll;
		const isPolling = !fieldsDeclared && !hasVerify && hasPoll;
		const isHybrid = hasFields && hasVerify && hasPoll;
		const emptyFieldsDeclared = fieldsDeclared && !hasFields;
		if (!emptyFieldsDeclared && (isInteractive || isPolling || isHybrid)) continue;

		const path = `challenges.${challengeId}`;
		violations.push({
			ruleId: DECLARATION_RULE_IDS.challengeShape,
			path,
			message: "challenge must be interactive, polling, or an explicit hybrid.",
			fix: `Give ${path} non-empty fields plus verify, poll alone, or all three for a hybrid.`,
		});
	}
	if (violations.length > 0) throw declarationInvalidError(violations);
}
