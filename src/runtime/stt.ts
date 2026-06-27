import { ProviderError, TransportError, ValidationError } from "../errors";
import type {
	Bcp47Locale,
	ProviderSttConfig,
	SttAudioInput,
	SttContext,
	SttPromptPolicy,
	SttSegment,
	SttTranscribeRequest,
	SttTranscript,
	SttUnsupportedOptionPolicy,
	SttVerificationCodeOptions,
	VerificationCodeCandidate,
	VerificationCodeCandidateSource,
	VerificationCodeExtractionResult,
} from "../types";

export const APIFUSE__STT__BACKEND_ENV = "APIFUSE__STT__BACKEND";
export const APIFUSE__STT__MODEL_ENV = "APIFUSE__STT__MODEL";
export const CLOUDFLARE_ACCOUNT_ID_ENV = "APIFUSE__CLOUDFLARE__ACCOUNT_ID";
export const APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV =
	"APIFUSE__STT__CLOUDFLARE_API_TOKEN";
export const CLOUDFLARE_WORKERS_AI_STT_BACKEND = "cloudflare-workers-ai";
export const DEFAULT_CLOUDFLARE_WORKERS_AI_STT_MODEL =
	"@cf/openai/whisper-large-v3-turbo";
export const DEFAULT_STT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const DEFAULT_STT_TIMEOUT_MS = 30_000;

const BASE64_AUDIO_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const DEFAULT_OTP_HINT =
	"Transcribe verification codes using Arabic numerals only. Preserve leading zeros and spacing.";

type EnvLike = Record<string, string | undefined>;

type CloudflareWorkersAiSttClientOptions = {
	accountId: string;
	apiToken: string;
	model?: string;
	fetch?: typeof fetch;
};

type ErrorSttClientOptions = {
	code: string;
	message: string;
	fix?: string;
};

function providerError(
	message: string,
	options: { code: string; fix?: string },
): ProviderError {
	return new ProviderError(message, options);
}

function createErrorSttClient(options: ErrorSttClientOptions): SttContext {
	return {
		async transcribe() {
			throw providerError(options.message, {
				code: options.code,
				fix: options.fix,
			});
		},
		extractVerificationCode,
	};
}

export function createUnsupportedSttClient(reason?: string): SttContext {
	return createErrorSttClient({
		code: "STT_UNAVAILABLE",
		message: reason ?? "STT runtime is not configured",
		fix: `Configure ${APIFUSE__STT__BACKEND_ENV} and the matching backend credentials, or provide a test SttContext override.`,
	});
}

function normalizedEnvValue(env: EnvLike, key: string): string | undefined {
	const value = env[key]?.trim();
	return value ? value : undefined;
}

export function createSttClientFromEnv(
	config: ProviderSttConfig | undefined,
	env: EnvLike = process.env,
): SttContext {
	if (!config) {
		return createUnsupportedSttClient(
			"Provider does not declare STT capability",
		);
	}

	const backend = normalizedEnvValue(env, APIFUSE__STT__BACKEND_ENV);
	if (!backend) {
		return createUnsupportedSttClient(
			config.mode === "required"
				? `STT is required by this provider but ${APIFUSE__STT__BACKEND_ENV} is not configured`
				: undefined,
		);
	}

	if (backend !== CLOUDFLARE_WORKERS_AI_STT_BACKEND) {
		return createErrorSttClient({
			code: "UNSUPPORTED_STT_BACKEND",
			message: `Unsupported STT backend "${backend}"`,
			fix: `Use ${APIFUSE__STT__BACKEND_ENV}=${CLOUDFLARE_WORKERS_AI_STT_BACKEND} or provide a custom SttContext override.`,
		});
	}

	const accountId = env.APIFUSE__CLOUDFLARE__ACCOUNT_ID?.trim();
	const apiToken = env.APIFUSE__STT__CLOUDFLARE_API_TOKEN?.trim();
	if (!accountId || !apiToken) {
		return createUnsupportedSttClient(
			`STT backend ${backend} requires ${CLOUDFLARE_ACCOUNT_ID_ENV} and ${APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV}`,
		);
	}

	return createCloudflareWorkersAiSttClient({
		accountId,
		apiToken,
		model:
			normalizedEnvValue(env, APIFUSE__STT__MODEL_ENV) ??
			DEFAULT_CLOUDFLARE_WORKERS_AI_STT_MODEL,
	});
}

function base64ByteLength(data: string): number {
	const normalized = data.trim();
	const padding = normalized.endsWith("==")
		? 2
		: normalized.endsWith("=")
			? 1
			: 0;
	return Math.floor((normalized.length * 3) / 4) - padding;
}

function assertBase64Audio(
	audio: SttAudioInput,
	maxAudioBytes: number | undefined,
): number {
	if (audio.kind !== "base64") {
		throw new ValidationError("Unsupported STT audio input kind", {
			code: "UNSUPPORTED_STT_OPTION",
			fix: 'Use audio: { kind: "base64", data, mediaType } for STT v1.',
		});
	}
	const data = audio.data.trim();
	if (
		data.length === 0 ||
		data.length % 4 !== 0 ||
		!BASE64_AUDIO_PATTERN.test(data)
	) {
		throw new ValidationError(
			"STT audio.data must be a base64-encoded string",
			{
				code: "INVALID_STT_AUDIO",
			},
		);
	}
	const bytes = base64ByteLength(data);
	const maxBytes = maxAudioBytes ?? DEFAULT_STT_MAX_AUDIO_BYTES;
	if (bytes > maxBytes) {
		throw new ValidationError(
			`STT audio exceeds maxAudioBytes (${bytes} > ${maxBytes})`,
			{ code: "STT_AUDIO_TOO_LARGE" },
		);
	}
	return bytes;
}

export function resolveSttPrompt(
	request: SttTranscribeRequest,
): string | undefined {
	const policy = effectivePromptPolicy(request);
	if (policy === "none") return undefined;
	if (policy === "default-hint") return DEFAULT_OTP_HINT;
	return request.initialPrompt;
}

function effectivePromptPolicy(request: SttTranscribeRequest): SttPromptPolicy {
	if (request.promptPolicy) return request.promptPolicy;
	return request.mode === "otp" ? "default-hint" : "none";
}

function warnOrThrowUnsupportedOption(
	request: SttTranscribeRequest,
	message: string,
): { code: "UNSUPPORTED_STT_OPTION"; message: string } | undefined {
	const policy: SttUnsupportedOptionPolicy =
		request.unsupportedOptionPolicy ?? "warn";
	if (policy === "error") {
		throw new ProviderError(message, { code: "UNSUPPORTED_STT_OPTION" });
	}
	return { code: "UNSUPPORTED_STT_OPTION", message };
}

function normalizeCloudflareLanguage(
	language: Bcp47Locale | undefined,
): string | undefined {
	return language?.split("-")[0]?.toLowerCase();
}

function isTimeoutLikeError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error.name === "AbortError" ||
			error.name === "TimeoutError" ||
			/\b(timed out|timeout|deadline exceeded)\b/i.test(error.message))
	);
}

function toSttTransportError(error: unknown): TransportError {
	if (error instanceof TransportError) return error;
	if (isTimeoutLikeError(error)) {
		return new TransportError("STT upstream request timed out", {
			code: "transport_timeout",
			status: 0,
			cause: error,
		});
	}
	return new TransportError("STT upstream network request failed", {
		code: "transport_network_error",
		status: 0,
		cause: error instanceof Error ? error : undefined,
	});
}

function createTimeoutController(signalTimeoutMs: number): {
	controller: AbortController;
	clear: () => void;
} {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), signalTimeoutMs);
	timeout.unref?.();
	return { controller, clear: () => clearTimeout(timeout) };
}

function toCloudflareInput(
	request: SttTranscribeRequest,
): Record<string, unknown> {
	const prompt = resolveSttPrompt(request);
	const input: Record<string, unknown> = {
		audio: request.audio.data.trim(),
		task: "transcribe",
	};
	const language = normalizeCloudflareLanguage(request.language);
	if (language) input.language = language;
	if (prompt) input.initial_prompt = prompt;
	return input;
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return Object.fromEntries(Object.entries(value));
}

function parseSegments(value: unknown): SttSegment[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const segments: SttSegment[] = [];
	for (const item of value) {
		const segment = unknownRecord(item);
		if (!segment || typeof segment.text !== "string") continue;
		segments.push({
			text: segment.text,
			startMs:
				typeof segment.start === "number"
					? Math.round(segment.start * 1000)
					: typeof segment.startMs === "number"
						? segment.startMs
						: undefined,
			endMs:
				typeof segment.end === "number"
					? Math.round(segment.end * 1000)
					: typeof segment.endMs === "number"
						? segment.endMs
						: undefined,
			confidence:
				typeof segment.confidence === "number" ? segment.confidence : undefined,
		});
	}
	return segments.length > 0 ? segments : undefined;
}

function toSttTranscript(payload: unknown, audioBytes: number): SttTranscript {
	const envelope = unknownRecord(payload);
	const result = unknownRecord(envelope?.result) ?? envelope;
	const info = unknownRecord(result?.transcription_info);
	const text =
		(typeof result?.text === "string" ? result.text : undefined) ??
		(typeof info?.text === "string" ? info.text : undefined);
	if (!text) {
		throw new TransportError(
			"STT upstream response did not include transcript text",
			{
				code: "STT_UPSTREAM_FAILED",
				status: 502,
			},
		);
	}
	const durationMs =
		typeof result?.durationMs === "number"
			? result.durationMs
			: typeof info?.duration === "number"
				? Math.round(info.duration * 1000)
				: undefined;
	return {
		text,
		language:
			typeof result?.language === "string"
				? result.language
				: typeof info?.language === "string"
					? info.language
					: undefined,
		durationMs,
		segments: parseSegments(result?.segments),
		usage: {
			audioBytes,
			...(durationMs ? { audioDurationMs: durationMs } : {}),
		},
	};
}

export function createCloudflareWorkersAiSttClient(
	options: CloudflareWorkersAiSttClientOptions,
): SttContext {
	const model = options.model ?? DEFAULT_CLOUDFLARE_WORKERS_AI_STT_MODEL;
	const runFetch = options.fetch ?? fetch;
	return {
		async transcribe(request) {
			const warnings = [];
			if (
				request.initialPrompt &&
				effectivePromptPolicy(request) !== "custom-hint"
			) {
				const warning = warnOrThrowUnsupportedOption(
					request,
					"initialPrompt is honored only when promptPolicy is custom-hint",
				);
				if (warning) warnings.push(warning);
			}
			const audioBytes = assertBase64Audio(
				request.audio,
				request.maxAudioBytes,
			);
			const timeout = createTimeoutController(
				request.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS,
			);
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
							body: JSON.stringify(toCloudflareInput(request)),
							signal: timeout.controller.signal,
						},
					);
				} catch (error) {
					throw toSttTransportError(error);
				}
				const payload = await response.json().catch(() => undefined);
				if (!response.ok) {
					throw new TransportError("STT upstream request failed", {
						code: "STT_UPSTREAM_FAILED",
						status: response.status,
						upstreamStatus: response.status,
					});
				}
				const envelope = unknownRecord(payload);
				if (envelope?.success === false) {
					throw new TransportError("STT upstream returned an error", {
						code: "STT_UPSTREAM_FAILED",
						status: 502,
					});
				}
				const transcript = toSttTranscript(payload, audioBytes);
				const withWarnings =
					warnings.length > 0
						? {
								...transcript,
								warnings: [...(transcript.warnings ?? []), ...warnings],
							}
						: transcript;
				if (request.mode === "otp" || request.verificationCode) {
					return {
						...withWarnings,
						verificationCode: extractVerificationCode(
							withWarnings.text,
							request.verificationCode,
						),
					};
				}
				return withWarnings;
			} finally {
				timeout.clear();
			}
		},
		extractVerificationCode,
	};
}

const EN_DIGITS: Record<string, string> = {
	zero: "0",
	oh: "0",
	o: "0",
	one: "1",
	two: "2",
	three: "3",
	four: "4",
	five: "5",
	six: "6",
	seven: "7",
	eight: "8",
	nine: "9",
};

const KO_DIGITS: Record<string, string> = {
	공: "0",
	영: "0",
	일: "1",
	이: "2",
	삼: "3",
	사: "4",
	오: "5",
	육: "6",
	륙: "6",
	칠: "7",
	팔: "8",
	구: "9",
};

function lengthSet(
	codeLengths: SttVerificationCodeOptions["codeLengths"],
): Set<number> {
	if (codeLengths === undefined) return new Set([4, 5, 6, 7, 8]);
	if (typeof codeLengths === "number")
		return new Set([validCodeLength(codeLengths)]);
	if (Array.isArray(codeLengths)) {
		const values = codeLengths.map((length) => validCodeLength(length));
		return new Set(values);
	}
	if (!("min" in codeLengths) || !("max" in codeLengths)) {
		throw new ValidationError("STT verification code range is malformed", {
			code: "INVALID_STT_VERIFICATION_CODE_OPTIONS",
		});
	}
	const min = validCodeLength(codeLengths.min);
	const max = validCodeLength(codeLengths.max);
	if (min > max) {
		throw new ValidationError("STT verification code range min exceeds max", {
			code: "INVALID_STT_VERIFICATION_CODE_OPTIONS",
		});
	}
	if (max - min > 16) {
		throw new ValidationError("STT verification code range is too large", {
			code: "INVALID_STT_VERIFICATION_CODE_OPTIONS",
		});
	}
	const values = new Set<number>();
	for (let length = min; length <= max; length += 1) {
		values.add(length);
	}
	return values;
}

function validCodeLength(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 32) {
		throw new ValidationError(
			"STT verification code length must be an integer between 1 and 32",
			{ code: "INVALID_STT_VERIFICATION_CODE_OPTIONS" },
		);
	}
	return value;
}

type DigitToken = {
	text: string;
	digits: string;
	source: "digits" | "spoken_words";
	startIndex: number;
	endIndex: number;
};

function sourceForGroup(tokens: DigitToken[]): VerificationCodeCandidateSource {
	const sources = new Set(tokens.map((token) => token.source));
	return sources.size === 1 ? (tokens[0]?.source ?? "digits") : "mixed";
}

function emitWordToken(token: string, startIndex: number): DigitToken[] {
	const lower = token.toLowerCase();
	const english = EN_DIGITS[lower];
	if (english) {
		return [
			{
				text: token,
				digits: english,
				source: "spoken_words",
				startIndex,
				endIndex: startIndex + token.length,
			},
		];
	}
	const korean = KO_DIGITS[token];
	if (korean) {
		return [
			{
				text: token,
				digits: korean,
				source: "spoken_words",
				startIndex,
				endIndex: startIndex + token.length,
			},
		];
	}
	const chars = [...token];
	if (chars.length > 1 && chars.every((char) => KO_DIGITS[char])) {
		let offset = startIndex;
		return chars.map((char) => {
			const item: DigitToken = {
				text: char,
				digits: KO_DIGITS[char] ?? "",
				source: "spoken_words",
				startIndex: offset,
				endIndex: offset + char.length,
			};
			offset += char.length;
			return item;
		});
	}
	return [];
}

function tokenizeDigits(text: string): DigitToken[] {
	const tokens: DigitToken[] = [];
	for (const match of text.matchAll(/[0-9]+|[A-Za-z]+|[가-힣]+/gu)) {
		const value = match[0];
		const index = match.index ?? 0;
		if (/^[0-9]+$/.test(value)) {
			tokens.push({
				text: value,
				digits: value,
				source: "digits",
				startIndex: index,
				endIndex: index + value.length,
			});
			continue;
		}
		tokens.push(...emitWordToken(value, index));
	}
	return tokens.sort((a, b) => a.startIndex - b.startIndex);
}

function isAdjacent(
	left: DigitToken,
	right: DigitToken,
	text: string,
): boolean {
	const between = text.slice(left.endIndex, right.startIndex);
	return /^[\s,.:;\-_/]*$/u.test(between);
}

function candidatesFromTokens(
	text: string,
	allowedLengths: Set<number>,
): VerificationCodeCandidate[] {
	const tokens = tokenizeDigits(text);
	const candidates: VerificationCodeCandidate[] = [];
	let group: DigitToken[] = [];
	const flush = () => {
		if (group.length === 0) return;
		const code = group.map((token) => token.digits).join("");
		if (allowedLengths.has(code.length)) {
			candidates.push({
				code,
				source: sourceForGroup(group),
				startIndex: group[0]?.startIndex,
				endIndex: group[group.length - 1]?.endIndex,
			});
		}
		group = [];
	};

	for (const token of tokens) {
		const previous = group[group.length - 1];
		if (previous && !isAdjacent(previous, token, text)) {
			flush();
		}
		group.push(token);
	}
	flush();
	return candidates;
}

export function extractVerificationCode(
	text: string,
	options: SttVerificationCodeOptions = {},
): VerificationCodeExtractionResult {
	const allowedLengths = lengthSet(options.codeLengths);
	const candidatesByCode = new Map<string, VerificationCodeCandidate>();
	for (const candidate of candidatesFromTokens(text, allowedLengths)) {
		if (!candidatesByCode.has(candidate.code)) {
			candidatesByCode.set(candidate.code, candidate);
		}
	}
	const candidates = [...candidatesByCode.values()];
	if (candidates.length === 0) {
		throw new ProviderError(
			"No verification code candidate found in transcript",
			{
				code: "NO_CODE_FOUND",
			},
		);
	}
	if (candidates.length > 1) {
		throw new ProviderError("Multiple verification code candidates found", {
			code: "AMBIGUOUS_CODE",
		});
	}
	const [candidate] = candidates;
	return {
		code: candidate.code,
		candidates,
		normalizedText: text.normalize("NFKC"),
	};
}
