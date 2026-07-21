import { createHash, randomBytes, randomUUID } from "node:crypto";

import Ajv2020 from "ajv/dist/2020.js";

import { AUTH_TURN_SCHEMA, type KnownAuthTurnKind } from "../auth-turn/index.js";
import {
	FlowExpiredError,
	ProviderSecretError,
	TurnValidationError,
	ValidationError,
} from "../errors.js";
import type { AuthFlowDefinition, AuthFlowInputHandler, AuthTurn, FlowContext } from "../types.js";

type TurnKind = KnownAuthTurnKind;

type CeremonyHandler = AuthFlowInputHandler;

type JsonObject = Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: true, strictSchema: true });

// Runtime ceremony-output validation derives from the exported versioned
// contract: it compiles the exact AUTH_TURN_SCHEMA document shipped at
// dist/auth-turn/auth-turn.v1.schema.json, so the two cannot drift.
const validateAuthTurn = ajv.compile(AUTH_TURN_SCHEMA);

const OAUTH2_STATE_KEY = "__oauth2_state";
const OAUTH2_PKCE_VERIFIER_KEY = "__oauth2_pkce_verifier";
const DEVICE_FLOW_KEY = "__device_flow";
const MAGIC_LINK_KEY = "__magic_link";
const COMBINED_STAGE_KEY = "__combined_stage";
const SWITCH_SELECTION_KEY = "__switch_selection";
const FORM_FIELD_ORDER_EXTENSION = "x-apifuse-field-order";

function isRecord(value: unknown): value is JsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function ensureRecord(value: unknown): JsonObject {
	return isRecord(value) ? value : {};
}

function createTurn(kind: TurnKind, options: Omit<AuthTurn, "kind" | "turnId"> = {}): AuthTurn {
	return {
		kind,
		turnId: randomUUID(),
		...options,
	};
}

function createExpiresAt(ttlMs: number): string {
	return new Date(Date.now() + ttlMs).toISOString();
}

function getRequiredEnv(ctx: FlowContext, key: string): string {
	const value = ctx.env.get(key);
	if (!value) {
		throw new ProviderSecretError(`Missing required secret: ${key}`);
	}
	return value;
}

function toBase64Url(input: Buffer): string {
	return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createCodeVerifier(): string {
	return toBase64Url(randomBytes(32));
}

function createCodeChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

function normalizeError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new Error("Unexpected ceremony error");
}

function toRetryTurn(error: unknown, hint: string): AuthTurn {
	const normalizedError = normalizeError(error);

	if (normalizedError instanceof FlowExpiredError) {
		return validateCeremonyOutput(
			createTurn("abort", {
				hint: normalizedError.message,
				data: { code: normalizedError.code ?? "flow_expired" },
			}),
		);
	}

	const retryData =
		normalizedError instanceof ValidationError
			? { errors: normalizedError.zodError }
			: { error: normalizedError.message };

	return validateCeremonyOutput(
		createTurn("retry", {
			hint: `${hint}: ${normalizedError.message}`,
			data: retryData,
		}),
	);
}

async function runCeremonyHandler(
	handler: CeremonyHandler,
	hint: string,
	ctx: FlowContext,
	input?: Record<string, unknown>,
): Promise<AuthTurn> {
	try {
		return validateCeremonyOutput(await handler(ctx, input));
	} catch (error) {
		return toRetryTurn(error, hint);
	}
}

function getString(input: Record<string, unknown>, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" ? value : undefined;
}

function getNestedRecord(ctx: FlowContext, key: string): JsonObject {
	return ensureRecord(ctx.context.get(key));
}

function buildJsonSchemaForm(expectedInput: JsonObject, hint: string): AuthTurn {
	return createTurn("form", {
		hint,
		expectedInput: withDeclaredFormFieldOrder(expectedInput),
		data: {},
	});
}

function withDeclaredFormFieldOrder(expectedInput: JsonObject): JsonObject {
	const properties = expectedInput.properties;
	if (!isRecord(properties)) {
		return expectedInput;
	}

	const existingOrder = expectedInput[FORM_FIELD_ORDER_EXTENSION];
	if (Array.isArray(existingOrder) && existingOrder.every((value) => typeof value === "string")) {
		return expectedInput;
	}

	return {
		...expectedInput,
		[FORM_FIELD_ORDER_EXTENSION]: Object.keys(properties),
	};
}

export function validateCeremonyOutput(turn: unknown): AuthTurn {
	if (!validateAuthTurn(turn)) {
		const detail = validateAuthTurn.errors
			?.map((error) => `${error.instancePath || "$"} ${error.message ?? "invalid"}`)
			.join("; ");
		throw new TurnValidationError(detail || "Invalid AuthTurn output");
	}

	return turn;
}

export function createOAuth2Ceremony(options: {
	authorizeUrl: string;
	tokenUrl: string;
	clientIdEnvKey: string;
	clientSecretEnvKey: string;
	scopes: string[];
	usePKCE?: boolean;
}): AuthFlowDefinition {
	return {
		start: (ctx) =>
			runCeremonyHandler(
				async () => {
					const clientId = getRequiredEnv(ctx, options.clientIdEnvKey);
					getRequiredEnv(ctx, options.clientSecretEnvKey);
					const state = toBase64Url(randomBytes(24));
					ctx.context.set(OAUTH2_STATE_KEY, state);

					const authorizeUrl = new URL(options.authorizeUrl);
					authorizeUrl.searchParams.set("response_type", "code");
					authorizeUrl.searchParams.set("client_id", clientId);
					authorizeUrl.searchParams.set("state", state);
					if (options.scopes.length > 0) {
						authorizeUrl.searchParams.set("scope", options.scopes.join(" "));
					}

					if (options.usePKCE) {
						const verifier = createCodeVerifier();
						ctx.context.set(OAUTH2_PKCE_VERIFIER_KEY, verifier);
						authorizeUrl.searchParams.set("code_challenge", createCodeChallenge(verifier));
						authorizeUrl.searchParams.set("code_challenge_method", "S256");
					}

					return createTurn("redirect", {
						data: { url: authorizeUrl.toString() },
						hint: "Open the provider authorization page to continue.",
						expectedInput: {
							type: "object",
							required: ["code", "state"],
							properties: {
								code: { type: "string" },
								state: { type: "string" },
							},
						},
					});
				},
				"OAuth start failed",
				ctx,
			),
		continue: (ctx, input = {}) =>
			runCeremonyHandler(
				async () => {
					const code = getString(input, "code");
					const receivedState = getString(input, "state");
					const storedState = ctx.context.get(OAUTH2_STATE_KEY);
					const codeVerifier = ctx.context.get(OAUTH2_PKCE_VERIFIER_KEY);

					if (!code || !receivedState || receivedState !== storedState) {
						throw new ValidationError("OAuth callback payload is invalid.");
					}

					const tokenResponse = await ctx.http.post(options.tokenUrl, {
						grant_type: "authorization_code",
						code,
						client_id: getRequiredEnv(ctx, options.clientIdEnvKey),
						client_secret: getRequiredEnv(ctx, options.clientSecretEnvKey),
						...(options.usePKCE
							? typeof codeVerifier === "string"
								? { code_verifier: codeVerifier }
								: {}
							: {}),
					});

					return createTurn("complete", {
						data: { credential: ensureRecord(tokenResponse.data) },
						hint: "OAuth flow completed.",
					});
				},
				"OAuth token exchange failed",
				ctx,
				input,
			),
		abort: async () => validateCeremonyOutput(createTurn("abort", { hint: "OAuth flow aborted." })),
	};
}

export function createDeviceFlowCeremony(options: {
	deviceCodeUrl: string;
	tokenUrl: string;
	clientIdEnvKey: string;
	clientSecretEnvKey?: string;
	scopes: string[];
}): AuthFlowDefinition {
	return {
		start: (ctx) =>
			runCeremonyHandler(
				async () => {
					const response = await ctx.http.post(options.deviceCodeUrl, {
						client_id: getRequiredEnv(ctx, options.clientIdEnvKey),
						scope: options.scopes.join(" "),
					});
					const data = ensureRecord(response.data);
					ctx.context.set(DEVICE_FLOW_KEY, data);

					return createTurn("message", {
						data: {
							user_code: getString(data, "user_code") ?? "",
							verification_uri: getString(data, "verification_uri") ?? "",
						},
						hint: "Enter the code on the verification page, then poll for completion.",
						timing: { suggestedPollIntervalMs: 5_000, maxWaitMs: 120_000 },
					});
				},
				"Device flow start failed",
				ctx,
			),
		continue: async () =>
			validateCeremonyOutput(
				createTurn("poll", {
					hint: "Continue polling until the device flow completes.",
					timing: { suggestedPollIntervalMs: 5_000, maxWaitMs: 120_000 },
				}),
			),
		poll: (ctx) =>
			runCeremonyHandler(
				async () => {
					const deviceData = getNestedRecord(ctx, DEVICE_FLOW_KEY);
					const deviceCode = getString(deviceData, "device_code");
					if (!deviceCode) {
						throw new FlowExpiredError("Device flow state is missing.");
					}

					const response = await ctx.http.post(options.tokenUrl, {
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						device_code: deviceCode,
						client_id: getRequiredEnv(ctx, options.clientIdEnvKey),
						...(options.clientSecretEnvKey
							? {
									client_secret: getRequiredEnv(ctx, options.clientSecretEnvKey),
								}
							: {}),
					});
					const data = ensureRecord(response.data);
					const errorCode = getString(data, "error");

					if (errorCode === "authorization_pending" || errorCode === "slow_down") {
						return createTurn("poll", {
							data,
							hint: "Authorization pending.",
							timing: {
								suggestedPollIntervalMs: errorCode === "slow_down" ? 10_000 : 5_000,
								maxWaitMs: 120_000,
							},
						});
					}

					if (errorCode === "expired_token") {
						throw new FlowExpiredError("Device code expired.");
					}

					return createTurn("complete", {
						data: { credential: data },
						hint: "Device flow completed.",
					});
				},
				"Device flow polling failed",
				ctx,
			),
		abort: async () =>
			validateCeremonyOutput(createTurn("abort", { hint: "Device flow aborted." })),
	};
}

export function createWebAuthnCeremony(options: {
	rpId: string;
	challengeUrl?: string;
	verifyUrl?: string;
	timeoutMs?: number;
}): AuthFlowDefinition {
	return {
		start: (ctx) =>
			runCeremonyHandler(
				async () => {
					const challenge = toBase64Url(randomBytes(32));
					ctx.context.set("__webauthn_challenge", challenge);

					if (options.challengeUrl) {
						await ctx.http.post(options.challengeUrl, {
							challenge,
							rpId: options.rpId,
						});
					}

					return createTurn("challenge", {
						data: { challenge, rpId: options.rpId },
						hint: "Complete the WebAuthn prompt in your browser.",
						expiresAt: createExpiresAt(options.timeoutMs ?? 60_000),
						expectedInput: {
							type: "object",
							required: ["attestation"],
							properties: { attestation: { type: "object" } },
						},
					});
				},
				"WebAuthn start failed",
				ctx,
			),
		continue: (ctx, input = {}) =>
			runCeremonyHandler(
				async () => {
					if (!isRecord(input.attestation)) {
						throw new ValidationError("WebAuthn attestation is required.");
					}

					const challenge = ctx.context.get("__webauthn_challenge");
					if (typeof challenge !== "string" || challenge.length === 0) {
						throw new FlowExpiredError("WebAuthn challenge has expired.");
					}

					if (options.verifyUrl) {
						await ctx.http.post(options.verifyUrl, {
							challenge,
							attestation: input.attestation,
							rpId: options.rpId,
						});
					}

					return createTurn("complete", {
						data: { credential: { attestation: input.attestation } },
						hint: "WebAuthn ceremony completed.",
					});
				},
				"WebAuthn verification failed",
				ctx,
				input,
			),
		abort: async () =>
			validateCeremonyOutput(createTurn("abort", { hint: "WebAuthn ceremony aborted." })),
	};
}

export function createMagicLinkCeremony(options: {
	sendUrl: string;
	verifyUrl: string;
	emailField?: string;
	expiresInMs?: number;
}): AuthFlowDefinition {
	const emailField = options.emailField ?? "email";

	return {
		start: (ctx, input = {}) =>
			runCeremonyHandler(
				async () => {
					const email = getString(input, emailField);
					if (!email) {
						return buildJsonSchemaForm(
							{
								type: "object",
								required: [emailField],
								properties: {
									[emailField]: { type: "string", format: "email" },
								},
							},
							"Provide the email address to receive a magic link.",
						);
					}

					await ctx.http.post(options.sendUrl, { email });
					ctx.context.set(MAGIC_LINK_KEY, {
						email,
						expiresAt: createExpiresAt(options.expiresInMs ?? 300_000),
					});

					return createTurn("message", {
						data: { email },
						hint: "Check your email for the magic link, then poll for completion.",
						timing: { suggestedPollIntervalMs: 5_000, maxWaitMs: 300_000 },
					});
				},
				"Magic link start failed",
				ctx,
				input,
			),
		continue: async () =>
			validateCeremonyOutput(
				createTurn("poll", {
					hint: "Continue polling for magic link completion.",
					timing: { suggestedPollIntervalMs: 5_000, maxWaitMs: 300_000 },
				}),
			),
		poll: (ctx) =>
			runCeremonyHandler(
				async () => {
					const state = getNestedRecord(ctx, MAGIC_LINK_KEY);
					const email = getString(state, "email");
					const expiresAt = getString(state, "expiresAt");

					if (!email || !expiresAt) {
						throw new FlowExpiredError("Magic link state is missing.");
					}

					if (new Date(expiresAt).getTime() < Date.now()) {
						throw new FlowExpiredError("Magic link expired.");
					}

					const response = await ctx.http.post(options.verifyUrl, { email });
					const data = ensureRecord(response.data);
					if (data.completed !== true) {
						return createTurn("poll", {
							data,
							hint: "Waiting for the magic link click.",
							timing: { suggestedPollIntervalMs: 5_000, maxWaitMs: 300_000 },
						});
					}

					return createTurn("complete", {
						data: { credential: ensureRecord(data.credential) },
						hint: "Magic link completed.",
					});
				},
				"Magic link polling failed",
				ctx,
			),
		abort: async () =>
			validateCeremonyOutput(createTurn("abort", { hint: "Magic link flow aborted." })),
	};
}

export function createFormCeremony(options: {
	schema: JsonObject;
	hint?: string;
	mapCredential?: (input: Record<string, unknown>) => JsonObject;
}): AuthFlowDefinition {
	return {
		start: async () =>
			validateCeremonyOutput(
				buildJsonSchemaForm(
					options.schema,
					options.hint ?? "Provide the required input to continue.",
				),
			),
		continue: (ctx, input = {}) =>
			runCeremonyHandler(
				async () => {
					const { prevalidate } = await import("../runtime/prevalidate.js");
					const result = prevalidate(options.schema, input);
					if (!result.valid) {
						throw new ValidationError("Form input failed validation.", {
							zodError: result.errors,
						});
					}

					return createTurn("complete", {
						data: {
							credential: options.mapCredential ? options.mapCredential(input) : input,
						},
						hint: "Form completed.",
					});
				},
				"Form submission failed",
				ctx,
				input,
			),
		abort: async () =>
			validateCeremonyOutput(createTurn("abort", { hint: "Form ceremony aborted." })),
	};
}

export function combineCeremonies(...ceremonies: AuthFlowDefinition[]): AuthFlowDefinition {
	function getStage(ctx: FlowContext): number {
		const rawStage = ctx.context.get(COMBINED_STAGE_KEY);
		return typeof rawStage === "number" ? rawStage : 0;
	}

	return {
		start: (ctx) =>
			runCeremonyHandler(
				async () => {
					ctx.context.set(COMBINED_STAGE_KEY, 0);
					const first = ceremonies[0];
					if (!first) {
						throw new ValidationError("At least one ceremony is required.");
					}
					return await first.start(ctx);
				},
				"Combined ceremony start failed",
				ctx,
			),
		continue: (ctx, input = {}) =>
			runCeremonyHandler(
				async () => {
					const stage = getStage(ctx);
					const current = ceremonies[stage];
					if (!current) {
						throw new FlowExpiredError("Combined ceremony stage is invalid.");
					}

					const result = await current.continue(ctx, input);
					if (result.kind !== "complete") {
						return result;
					}

					const nextStage = stage + 1;
					const nextCeremony = ceremonies[nextStage];
					if (!nextCeremony) {
						return result;
					}

					ctx.context.set(COMBINED_STAGE_KEY, nextStage);
					return await nextCeremony.start(ctx);
				},
				"Combined ceremony continue failed",
				ctx,
				input,
			),
		poll: (ctx) =>
			runCeremonyHandler(
				async () => {
					const current = ceremonies[getStage(ctx)];
					if (!current?.poll) {
						throw new ValidationError("Current ceremony does not support polling.");
					}
					return await current.poll(ctx);
				},
				"Combined ceremony poll failed",
				ctx,
			),
		abort: (ctx) =>
			runCeremonyHandler(
				async () => {
					const current = ceremonies[getStage(ctx)];
					if (current?.abort) {
						return await current.abort(ctx);
					}
					return createTurn("abort", { hint: "Combined ceremony aborted." });
				},
				"Combined ceremony abort failed",
				ctx,
			),
	};
}

export function createSwitchCeremony(options: {
	choices: Record<string, AuthFlowDefinition>;
	prompt?: string;
}): AuthFlowDefinition {
	const choiceKeys = Object.keys(options.choices);

	return {
		start: async () =>
			validateCeremonyOutput(
				createTurn("multi_choice", {
					data: { choices: choiceKeys },
					hint: options.prompt ?? "Choose an authentication method.",
					expectedInput: {
						type: "object",
						required: ["choice"],
						properties: {
							choice: { type: "string", enum: choiceKeys },
						},
					},
				}),
			),
		continue: (ctx, input = {}) =>
			runCeremonyHandler(
				async () => {
					const storedChoice = ctx.context.get(SWITCH_SELECTION_KEY);
					const choice =
						typeof storedChoice === "string" ? storedChoice : getString(input, "choice");

					if (!choice || !options.choices[choice]) {
						throw new ValidationError("A valid choice is required.");
					}

					ctx.context.set(SWITCH_SELECTION_KEY, choice);
					const ceremony = options.choices[choice];
					if (storedChoice === undefined) {
						return await ceremony.start(ctx);
					}

					return await ceremony.continue(ctx, input);
				},
				"Switch ceremony failed",
				ctx,
				input,
			),
		poll: (ctx) =>
			runCeremonyHandler(
				async () => {
					const choice = ctx.context.get(SWITCH_SELECTION_KEY);
					if (typeof choice !== "string") {
						throw new FlowExpiredError("No selected ceremony is active.");
					}

					const ceremony = options.choices[choice];
					if (!ceremony?.poll) {
						throw new ValidationError("Selected ceremony does not support polling.");
					}

					return await ceremony.poll(ctx);
				},
				"Switch ceremony poll failed",
				ctx,
			),
		abort: (ctx) =>
			runCeremonyHandler(
				async () => {
					const choice = ctx.context.get(SWITCH_SELECTION_KEY);
					if (typeof choice === "string") {
						const ceremony = options.choices[choice];
						if (ceremony?.abort) {
							return await ceremony.abort(ctx);
						}
					}

					return createTurn("abort", { hint: "Switch ceremony aborted." });
				},
				"Switch ceremony abort failed",
				ctx,
			),
	};
}
