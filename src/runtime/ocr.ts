import { ProviderError, TransportError } from "../errors.js";
import type {
	OcrCaptchaCandidate,
	OcrCaptchaOptions,
	OcrCaptchaResult,
	OcrContext,
	OcrImageInput,
	OcrRecognizeRequest,
	OcrResult,
	ProviderOcrConfig,
} from "../types.js";
import { CLOUDFLARE_ACCOUNT_ID_ENV } from "./stt.js";
import { createTimeoutController, isTimeoutLikeError } from "./timeout.js";

export { CLOUDFLARE_ACCOUNT_ID_ENV } from "./stt.js";

export const APIFUSE__OCR__BACKEND_ENV = "APIFUSE__OCR__BACKEND";
export const APIFUSE__OCR__MODEL_ENV = "APIFUSE__OCR__MODEL";
export const APIFUSE__OCR__CLOUDFLARE_API_TOKEN_ENV = "APIFUSE__OCR__CLOUDFLARE_API_TOKEN";
export const APIFUSE__OCR__BASE_URL_ENV = "APIFUSE__OCR__BASE_URL";
export const APIFUSE__OCR__API_KEY_ENV = "APIFUSE__OCR__API_KEY";
export const CLOUDFLARE_WORKERS_AI_OCR_BACKEND = "cloudflare-workers-ai";
export const OPENAI_COMPATIBLE_OCR_BACKEND = "openai-compatible";
export const DEFAULT_CLOUDFLARE_WORKERS_AI_OCR_MODEL = "@cf/google/gemma-4-26b-a4b-it";

export const DEFAULT_OCR_TIMEOUT_MS = 30_000;
const DEFAULT_CAPTCHA_MAX_TOKENS = 64;
const DEFAULT_DOCUMENT_MAX_TOKENS = 4_096;
const KIMI_MIN_MAX_TOKENS = 3_000;
const DEFAULT_MAX_CAPTCHA_CANDIDATES = 3;
const MAX_HOMOGLYPH_SEARCH_NODES = 512;
const HOMOGLYPH_CLASSES: readonly (readonly string[])[] = [
	["I", "l", "1", "i"],
	["O", "0", "o"],
	["S", "5", "s"],
	["Z", "2", "z"],
	["B", "8"],
];

const HINT_PROMPTS = {
	captcha:
		"Read the CAPTCHA image. Return only the characters, with no explanation. Preserve character case.",
	document: "Transcribe all visible text in the document image.",
	generic: "Read and return the visible text in this image.",
} as const;

type EnvLike = Record<string, string | undefined>;

type CloudflareWorkersAiOcrClientOptions = {
	accountId: string;
	apiToken: string;
	model?: string;
	fetch?: typeof fetch;
};

type OpenAiCompatibleOcrClientOptions = {
	baseUrl: string;
	apiKey?: string;
	model: string;
	fetch?: typeof fetch;
};

type ErrorOcrClientOptions = {
	code: string;
	message: string;
	fix?: string;
};

function providerError(message: string, options: { code: string; fix?: string }): ProviderError {
	return new ProviderError(message, options);
}

function createErrorOcrClient(options: ErrorOcrClientOptions): OcrContext {
	const unavailable = (): never => {
		throw providerError(options.message, {
			code: options.code,
			fix: options.fix,
		});
	};
	return {
		async recognize() {
			return unavailable();
		},
		async extractCaptchaText() {
			return unavailable();
		},
	};
}

export function createUnsupportedOcrClient(reason?: string): OcrContext {
	return createErrorOcrClient({
		code: "OCR_UNAVAILABLE",
		message: reason ?? "OCR runtime is not configured",
		fix: `Configure ${APIFUSE__OCR__BACKEND_ENV} and ${APIFUSE__OCR__MODEL_ENV}; Cloudflare uses ${CLOUDFLARE_ACCOUNT_ID_ENV} and ${APIFUSE__OCR__CLOUDFLARE_API_TOKEN_ENV}, while openai-compatible uses ${APIFUSE__OCR__BASE_URL_ENV} and optional ${APIFUSE__OCR__API_KEY_ENV}. Alternatively, provide a test OcrContext override.`,
	});
}

function normalizedEnvValue(env: EnvLike, key: string): string | undefined {
	const value = env[key]?.trim();
	return value ? value : undefined;
}

export function createOcrClientFromEnv(
	config: ProviderOcrConfig | undefined,
	env: EnvLike = process.env,
): OcrContext {
	if (!config) {
		return createUnsupportedOcrClient("Provider does not declare OCR capability");
	}

	const backend =
		normalizedEnvValue(env, APIFUSE__OCR__BACKEND_ENV) ?? CLOUDFLARE_WORKERS_AI_OCR_BACKEND;
	const configuredModel = normalizedEnvValue(env, APIFUSE__OCR__MODEL_ENV);

	if (backend === CLOUDFLARE_WORKERS_AI_OCR_BACKEND) {
		const model = configuredModel ?? DEFAULT_CLOUDFLARE_WORKERS_AI_OCR_MODEL;
		const accountId = normalizedEnvValue(env, CLOUDFLARE_ACCOUNT_ID_ENV);
		const apiToken = normalizedEnvValue(env, APIFUSE__OCR__CLOUDFLARE_API_TOKEN_ENV);
		if (!accountId || !apiToken) {
			return createUnsupportedOcrClient(
				`OCR backend ${backend} requires ${CLOUDFLARE_ACCOUNT_ID_ENV} and ${APIFUSE__OCR__CLOUDFLARE_API_TOKEN_ENV}`,
			);
		}
		return createCloudflareWorkersAiOcrClient({ accountId, apiToken, model });
	}

	if (backend === OPENAI_COMPATIBLE_OCR_BACKEND) {
		const baseUrl = normalizedEnvValue(env, APIFUSE__OCR__BASE_URL_ENV);
		if (!baseUrl) {
			return createUnsupportedOcrClient(
				`OCR backend ${backend} requires ${APIFUSE__OCR__BASE_URL_ENV}`,
			);
		}
		if (!configuredModel) {
			return createErrorOcrClient({
				code: "OCR_UNAVAILABLE",
				message: `OCR backend ${backend} requires ${APIFUSE__OCR__MODEL_ENV}`,
				fix: `Set ${APIFUSE__OCR__MODEL_ENV} to the exact model ID served by your self-hosted endpoint, for example ${APIFUSE__OCR__MODEL_ENV}=zai-org/GLM-OCR.`,
			});
		}
		return createOpenAiCompatibleOcrClient({
			baseUrl,
			apiKey: normalizedEnvValue(env, APIFUSE__OCR__API_KEY_ENV),
			model: configuredModel,
		});
	}

	return createErrorOcrClient({
		code: "UNSUPPORTED_OCR_BACKEND",
		message: `Unsupported OCR backend "${backend}"`,
		fix: `Use ${APIFUSE__OCR__BACKEND_ENV}=${CLOUDFLARE_WORKERS_AI_OCR_BACKEND} or ${APIFUSE__OCR__BACKEND_ENV}=${OPENAI_COMPATIBLE_OCR_BACKEND}, or provide a custom OcrContext override.`,
	});
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return Object.fromEntries(Object.entries(value));
}

function imageUrl(image: OcrImageInput): string {
	if (image.kind === "url") return image.url.trim();
	return `data:${image.mediaType?.trim() || "image/png"};base64,${image.data.trim()}`;
}

function resolvePrompt(request: OcrRecognizeRequest): string {
	return request.prompt ?? HINT_PROMPTS[request.hint ?? "generic"];
}

function isGemmaModel(model: string): boolean {
	return model.toLowerCase().includes("gemma");
}

function isKimiModel(model: string): boolean {
	return model.toLowerCase().includes("kimi");
}

function isMoondreamModel(model: string): boolean {
	return model.toLowerCase().includes("moondream");
}

function defaultMaxTokens(request: OcrRecognizeRequest): number {
	return request.hint === "captcha" ? DEFAULT_CAPTCHA_MAX_TOKENS : DEFAULT_DOCUMENT_MAX_TOKENS;
}

function resolvedMaxTokens(request: OcrRecognizeRequest, model = ""): number {
	const requestedMaxTokens = request.maxTokens ?? defaultMaxTokens(request);
	return isKimiModel(model)
		? Math.max(requestedMaxTokens, KIMI_MIN_MAX_TOKENS)
		: requestedMaxTokens;
}

function messagesPayload(request: OcrRecognizeRequest, model?: string): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		...(model ? { model } : {}),
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: resolvePrompt(request) },
					{ type: "image_url", image_url: { url: imageUrl(request.image) } },
				],
			},
		],
		max_tokens: resolvedMaxTokens(request, model),
		temperature: 0,
	};
	if (isGemmaModel(model ?? "")) {
		payload.chat_template_kwargs = { enable_thinking: false };
	}
	return payload;
}

function cloudflareMessagesPayload(
	request: OcrRecognizeRequest,
	model: string,
): Record<string, unknown> {
	const payload = messagesPayload(request, model);
	delete payload.model;
	return payload;
}

function moondreamPayload(request: OcrRecognizeRequest): Record<string, unknown> {
	return {
		task: "query",
		image: imageUrl(request.image),
		question: resolvePrompt(request),
		stream: true,
		reasoning: false,
		temperature: 0,
		max_tokens: resolvedMaxTokens(request),
	};
}

function incompleteResponseError(model: string, finishReason: string): TransportError {
	return new TransportError(
		`OCR model "${model}" did not complete normally (finish_reason: ${finishReason})`,
		{
			code: "OCR_INCOMPLETE_RESPONSE",
			status: 502,
			details: { finishReason },
		},
	);
}

function responseContent(payload: unknown, cloudflare: boolean, model: string): string | undefined {
	const envelope = unknownRecord(payload);
	const root = cloudflare ? unknownRecord(envelope?.result) : envelope;
	const choices = root?.choices;
	if (!Array.isArray(choices)) return undefined;
	const choice = unknownRecord(choices[0]);
	if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "stop") {
		throw incompleteResponseError(model, choice.finish_reason);
	}
	const message = unknownRecord(choice?.message);
	return typeof message?.content === "string" ? message.content.trim() || undefined : undefined;
}

function malformedResponseError(model: string, cause: Error): TransportError {
	return new TransportError(`OCR model "${model}" returned a malformed response`, {
		code: "OCR_UPSTREAM_FAILED",
		status: 502,
		cause,
	});
}

async function responseJson(response: Response, model: string): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		if (isTimeoutLikeError(error)) throw toOcrTransportError(error);
		throw malformedResponseError(
			model,
			error instanceof Error ? error : new Error("Failed to decode OCR response JSON"),
		);
	}
}

function moondreamSseContent(body: string, model: string): string | undefined {
	let finalAnswer: string | undefined;
	let firstDecodingFailure: Error | undefined;
	let terminalFinishReason: string | undefined;
	for (const line of body.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const data = trimmed.slice("data:".length).trim();
		if (!data || data === "[DONE]") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch (error) {
			firstDecodingFailure ??=
				error instanceof Error ? error : new Error("Failed to decode OCR SSE event");
			continue;
		}
		const event = unknownRecord(parsed);
		const chunk = unknownRecord(event?.chunk) ?? unknownRecord(event?.result) ?? event;
		if (
			chunk?.finish_reason === "stop" &&
			typeof chunk.answer === "string" &&
			chunk.answer.trim()
		) {
			finalAnswer = chunk.answer.trim();
		} else if (typeof chunk?.finish_reason === "string") {
			terminalFinishReason = chunk.finish_reason;
		}
	}
	if (finalAnswer) return finalAnswer;
	if (terminalFinishReason) throw incompleteResponseError(model, terminalFinishReason);
	if (firstDecodingFailure) throw malformedResponseError(model, firstDecodingFailure);
	return finalAnswer;
}

function emptyResponseError(model: string): TransportError {
	return new TransportError(`OCR model "${model}" returned no usable text`, {
		code: "OCR_UPSTREAM_FAILED",
		status: 502,
		fix: `Verify ${APIFUSE__OCR__MODEL_ENV}="${model}" supports image input and the runtime calling convention for that model.`,
	});
}

function toOcrTransportError(error: unknown): TransportError {
	if (error instanceof TransportError) return error;
	if (isTimeoutLikeError(error)) {
		return new TransportError("OCR upstream request timed out", {
			code: "transport_timeout",
			status: 0,
			cause: error,
		});
	}
	return new TransportError("OCR upstream network request failed", {
		code: "transport_network_error",
		status: 0,
		cause: error instanceof Error ? error : undefined,
	});
}

function createOcrClient(
	model: string,
	recognize: (request: OcrRecognizeRequest) => Promise<OcrResult>,
): OcrContext {
	return {
		recognize,
		async extractCaptchaText(image, options = {}): Promise<OcrCaptchaResult> {
			const result = await recognize({ image, hint: "captcha" });
			const candidates = extractCaptchaCandidates(result.text, options);
			const primary = candidates[0];
			if (!primary?.text) throw emptyResponseError(model);
			return {
				text: primary.text,
				candidates,
				satisfiesConstraints: primary.satisfiesConstraints,
				model: result.model,
			};
		},
	};
}

export function createCloudflareWorkersAiOcrClient(
	options: CloudflareWorkersAiOcrClientOptions,
): OcrContext {
	const model = options.model ?? DEFAULT_CLOUDFLARE_WORKERS_AI_OCR_MODEL;
	const runFetch = options.fetch ?? fetch;
	return createOcrClient(model, async (request) => {
		const timeout = createTimeoutController(request.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS);
		try {
			let response: Response;
			try {
				response = await runFetch(
					`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${model}`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${options.apiToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(
							isMoondreamModel(model)
								? moondreamPayload(request)
								: cloudflareMessagesPayload(request, model),
						),
						signal: timeout.controller.signal,
					},
				);
			} catch (error) {
				throw toOcrTransportError(error);
			}
			if (!response.ok) {
				throw new TransportError("OCR upstream request failed", {
					code: "OCR_UPSTREAM_FAILED",
					status: response.status,
					upstreamStatus: response.status,
				});
			}
			const text = isMoondreamModel(model)
				? moondreamSseContent(await response.text(), model)
				: responseContent(await responseJson(response, model), true, model);
			if (!text) throw emptyResponseError(model);
			return { text, model };
		} catch (error) {
			throw toOcrTransportError(error);
		} finally {
			timeout.clear();
		}
	});
}

export function createOpenAiCompatibleOcrClient(
	options: OpenAiCompatibleOcrClientOptions,
): OcrContext {
	const model = options.model;
	const runFetch = options.fetch ?? fetch;
	return createOcrClient(model, async (request) => {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
		const timeout = createTimeoutController(request.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS);
		try {
			let response: Response;
			try {
				response = await runFetch(`${options.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
					method: "POST",
					headers,
					body: JSON.stringify(messagesPayload(request, model)),
					signal: timeout.controller.signal,
				});
			} catch (error) {
				throw toOcrTransportError(error);
			}
			if (!response.ok) {
				throw new TransportError("OCR upstream request failed", {
					code: "OCR_UPSTREAM_FAILED",
					status: response.status,
					upstreamStatus: response.status,
				});
			}
			const text = responseContent(await responseJson(response, model), false, model);
			if (!text) throw emptyResponseError(model);
			return { text, model };
		} catch (error) {
			throw toOcrTransportError(error);
		} finally {
			timeout.clear();
		}
	});
}

function cleanCaptchaText(text: string): string {
	const afterColon = text.slice(text.lastIndexOf(":") + 1).trim();
	return afterColon.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
}

function caseFold(value: string, caseSensitive: boolean): string {
	return caseSensitive ? value : value.toLocaleLowerCase();
}

function matchesCharset(
	text: string,
	charset: string | RegExp | undefined,
	caseSensitive: boolean,
): boolean {
	if (charset === undefined) return true;
	if (typeof charset === "string") {
		const allowed = new Set([...caseFold(charset, caseSensitive)]);
		return [...caseFold(text, caseSensitive)].every((character) => allowed.has(character));
	}
	const flags = caseSensitive || charset.flags.includes("i") ? charset.flags : `${charset.flags}i`;
	const matcher = new RegExp(charset.source, flags);
	return [...text].every((character) => {
		matcher.lastIndex = 0;
		return matcher.test(character);
	});
}

function satisfiesCaptchaConstraints(text: string, options: OcrCaptchaOptions): boolean {
	const lengthMatches = options.length === undefined || [...text].length === options.length;
	return lengthMatches && matchesCharset(text, options.charset, options.caseSensitive !== false);
}

function homoglyphAlternatives(character: string): readonly string[] {
	const group = HOMOGLYPH_CLASSES.find((characters) => characters.includes(character));
	return group?.filter((alternative) => alternative !== character) ?? [];
}

export function extractCaptchaCandidates(
	modelText: string,
	options: OcrCaptchaOptions = {},
): readonly OcrCaptchaCandidate[] {
	const primaryText = cleanCaptchaText(modelText);
	const primary = {
		text: primaryText,
		satisfiesConstraints: satisfiesCaptchaConstraints(primaryText, options),
	};
	const requestedMaxCandidates = options.maxCandidates ?? DEFAULT_MAX_CAPTCHA_CANDIDATES;
	const maxCandidates = Number.isFinite(requestedMaxCandidates)
		? Math.max(1, Math.floor(requestedMaxCandidates))
		: DEFAULT_MAX_CAPTCHA_CANDIDATES;
	if (primary.satisfiesConstraints || maxCandidates === 1) return [primary];
	if (options.length !== undefined && [...primaryText].length !== options.length) return [primary];

	const candidates: OcrCaptchaCandidate[] = [primary];
	const queue = [primaryText];
	const visited = new Set(queue);
	for (let index = 0; index < queue.length && candidates.length < maxCandidates; index += 1) {
		const current = queue[index] ?? "";
		const characters = [...current];
		for (let position = 0; position < characters.length; position += 1) {
			const character = characters[position] ?? "";
			for (const alternative of homoglyphAlternatives(character)) {
				const nextCharacters = [...characters];
				nextCharacters[position] = alternative;
				const next = nextCharacters.join("");
				if (visited.has(next)) continue;
				visited.add(next);
				queue.push(next);
				if (satisfiesCaptchaConstraints(next, options)) {
					candidates.push({ text: next, satisfiesConstraints: true });
					if (candidates.length >= maxCandidates) return candidates;
				}
				if (visited.size >= MAX_HOMOGLYPH_SEARCH_NODES) return candidates;
			}
		}
	}
	return candidates;
}
