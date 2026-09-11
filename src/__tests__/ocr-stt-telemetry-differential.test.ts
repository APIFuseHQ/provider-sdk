import { describe, expect, it } from "bun:test";
import {
	createCloudflareWorkersAiOcrClient,
	createOpenAiCompatibleOcrClient,
} from "../runtime/ocr.js";
import { bindOcrTelemetry, OcrTelemetryCollector } from "../runtime/ocr-telemetry.js";
import { createCloudflareWorkersAiSttClient } from "../runtime/stt.js";
import { bindSttTelemetry, SttTelemetryCollector } from "../runtime/stt-telemetry.js";
import type {
	OcrContext,
	OcrRecognizeRequest,
	SttContext,
	SttTranscribeRequest,
} from "../types.js";

const index = { spans: [], byName: new Map(), count: () => 0, durationMs: () => 0 };
const data = Buffer.from("payload bytes for differential").toString("base64");
type Capture = {
	url: string;
	method: string | undefined;
	body: unknown;
	headers: Record<string, string>;
	aborted: boolean;
};
const ocrScenarios = [
	"success",
	"signed-url",
	"custom-prompt",
	"cloudflare",
	"moondream",
	"kimi",
	"upstream-400",
	"upstream-503",
	"timeout",
	"abort",
	"network",
	"malformed-response",
	"empty-candidates",
	"finish-length",
	"candidate-loop",
	"extract-error",
	"warnings-present",
] as const;
const sttScenarios = [
	"success",
	"usage",
	"warnings-present",
	"custom-prompt",
	"otp",
	"empty-candidates",
	"upstream-400",
	"upstream-503",
	"timeout",
	"abort",
	"network",
	"malformed-response",
	"empty-response",
	"envelope-error",
	"invalid-audio",
	"too-large",
	"unsupported-option",
	"ambiguous-code",
	"invalid-code-options",
] as const;
function upstream(scenario: string, cap: "ocr" | "stt", calls: Capture[]): typeof fetch {
	return Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const capture = {
			url: String(input),
			method: init?.method,
			body: init?.body,
			headers: Object.fromEntries(new Headers(init?.headers)),
			aborted: false,
		};
		calls.push(capture);
		if (scenario === "timeout") {
			await new Promise((_, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						capture.aborted = true;
						reject(new DOMException("timed out", "TimeoutError"));
					},
					{ once: true },
				);
			});
		}
		if (scenario === "abort") throw new DOMException("aborted upstream", "AbortError");
		if (scenario === "network") throw new Error("upstream network failure");
		if (scenario.startsWith("upstream-"))
			return Response.json({ error: scenario }, { status: Number(scenario.slice(-3)) });
		if (scenario === "malformed-response") return new Response("{invalid-json");
		if (cap === "ocr") {
			if (scenario === "moondream")
				return new Response('data: {"chunk":{"answer":"ok","finish_reason":"stop"}}\n');
			const payload = {
				choices:
					scenario === "empty-candidates"
						? []
						: [
								{
									finish_reason: scenario === "finish-length" ? "length" : "stop",
									message: {
										content:
											scenario === "candidate-loop"
												? "I0S"
												: scenario === "extract-error"
													? "!!!"
													: "ok",
									},
								},
							],
			};
			return Response.json(
				scenario === "cloudflare" || scenario === "kimi" ? { result: payload } : payload,
			);
		}
		return Response.json(
			scenario === "envelope-error"
				? { success: false, errors: ["vendor rejected"] }
				: {
						result: {
							text:
								scenario === "empty-response"
									? ""
									: scenario === "empty-candidates"
										? "no numeric code"
										: scenario === "ambiguous-code"
											? "1234 or 5678"
											: "one two three four",
							...(scenario === "usage"
								? { durationMs: 1234, segments: [{ text: "one", start: 0, end: 1 }] }
								: {}),
						},
					},
		);
	}, fetch);
}
async function runOcr(scenario: (typeof ocrScenarios)[number], observed: boolean) {
	const calls: Capture[] = [];
	const collector = new OcrTelemetryCollector();
	const request: OcrRecognizeRequest = {
		image:
			scenario === "signed-url"
				? { kind: "url", url: "https://image.test/a?sig=signed-value" }
				: { kind: "base64", data },
		...(scenario === "custom-prompt" ? { prompt: "custom prompt", maxTokens: 123 } : {}),
		timeoutMs: scenario === "timeout" ? 5 : 1000,
	};
	const factory = ["cloudflare", "moondream", "kimi"].includes(scenario)
		? createCloudflareWorkersAiOcrClient
		: createOpenAiCompatibleOcrClient;
	const model =
		scenario === "moondream"
			? "@cf/moondream/moondream3.1-9B-A2B"
			: scenario === "kimi"
				? "@cf/moonshotai/kimi-k2.7-code"
				: "vision-model";
	const actual = factory({
		accountId: "account",
		apiToken: "token",
		apiKey: "token",
		baseUrl: "https://ocr.test/v1",
		model,
		fetch: upstream(scenario, "ocr", calls),
	});
	let returned: unknown;
	let thrown: unknown;
	let inputSeen: unknown;
	let optionsSeen: unknown;
	let methodCalls = 0;
	const host: OcrContext = {
		async recognize(input) {
			methodCalls++;
			inputSeen = input;
			try {
				returned =
					scenario === "warnings-present"
						? { text: "ok", model, warnings: [{ code: "WARN", message: "vendor warning" }] }
						: await actual.recognize(input);
				return returned as Awaited<ReturnType<OcrContext["recognize"]>>;
			} catch (error) {
				thrown = error;
				throw error;
			}
		},
		async extractCaptchaText(image, opts) {
			methodCalls++;
			inputSeen = image;
			optionsSeen = opts;
			try {
				returned = await actual.extractCaptchaText(image, opts);
				return returned as Awaited<ReturnType<OcrContext["extractCaptchaText"]>>;
			} catch (error) {
				thrown = error;
				throw error;
			}
		},
	};
	const context = observed ? bindOcrTelemetry(host, collector) : host;
	const extract = scenario === "candidate-loop" || scenario === "extract-error";
	const options = { charset: "0123456789", maxCandidates: 4 };
	let result: unknown;
	let error: unknown;
	try {
		result = extract
			? await context.extractCaptchaText(request.image, options)
			: await context.recognize(request);
	} catch (caught) {
		error = caught;
	}
	expect(inputSeen).toBe(extract ? request.image : request);
	if (extract) expect(optionsSeen).toBe(options);
	expect(methodCalls).toBe(1);
	if (error) {
		if (!(error instanceof Error) || !(thrown instanceof Error))
			throw new Error("Expected Error identity");
		expect(error).toBe(thrown);
		expect(error.message).toBe(thrown.message);
	} else expect(result).toBe(returned);
	expect(calls).toHaveLength(scenario === "warnings-present" ? 0 : 1);
	const log = collector.toLogPayload(index);
	expect(log?.samples?.length ?? 0).toBe(observed ? 1 : 0);
	if (observed && scenario === "candidate-loop") expect(log?.candidates).toBeGreaterThan(1);
	if (observed && scenario === "warnings-present") expect(log?.warnings).toBe(1);
	return {
		calls,
		result,
		error:
			error instanceof Error
				? {
						name: error.name,
						message: error.message,
						...("code" in error ? { code: error.code } : {}),
					}
				: error,
	};
}
async function runStt(scenario: (typeof sttScenarios)[number], observed: boolean) {
	const calls: Capture[] = [];
	const collector = new SttTelemetryCollector();
	const request: SttTranscribeRequest = {
		audio: { kind: "base64", data: scenario === "invalid-audio" ? "!invalid!" : data },
		timeoutMs: scenario === "timeout" ? 5 : 1000,
		...(["warnings-present", "unsupported-option"].includes(scenario)
			? { initialPrompt: "ignored prompt" }
			: {}),
		...(scenario === "unsupported-option" ? { unsupportedOptionPolicy: "error" as const } : {}),
		...(scenario === "too-large" ? { maxAudioBytes: 1 } : {}),
		...(scenario === "invalid-code-options" ? { verificationCode: { codeLengths: 0 } } : {}),
		...(scenario === "custom-prompt"
			? { promptPolicy: "custom-hint" as const, initialPrompt: "custom hint", language: "en-US" }
			: {}),
		...(["otp", "empty-candidates", "ambiguous-code", "invalid-code-options"].includes(scenario)
			? { mode: "otp" as const }
			: {}),
	};
	const actual = createCloudflareWorkersAiSttClient({
		accountId: "account",
		apiToken: "token",
		fetch: upstream(scenario, "stt", calls),
	});
	let returned: unknown;
	let thrown: unknown;
	let inputSeen: unknown;
	let methodCalls = 0;
	const host: SttContext = {
		async transcribe(input) {
			methodCalls++;
			inputSeen = input;
			try {
				const result = await actual.transcribe(input);
				returned = result;
				return result;
			} catch (error) {
				thrown = error;
				throw error;
			}
		},
		extractVerificationCode: actual.extractVerificationCode,
	};
	const context = observed ? bindSttTelemetry(host, collector) : host;
	let result: unknown;
	let error: unknown;
	try {
		result = await context.transcribe(request);
	} catch (caught) {
		error = caught;
	}
	expect(inputSeen).toBe(request);
	expect(methodCalls).toBe(1);
	if (error) {
		if (!(error instanceof Error) || !(thrown instanceof Error))
			throw new Error("Expected Error identity");
		expect(error).toBe(thrown);
		expect(error.message).toBe(thrown.message);
	} else expect(result).toBe(returned);
	expect(calls).toHaveLength(
		["invalid-audio", "too-large", "unsupported-option"].includes(scenario) ? 0 : 1,
	);
	const log = collector.toLogPayload(index);
	expect(log?.samples?.length ?? 0).toBe(observed ? 1 : 0);
	if (observed && scenario === "warnings-present") expect(log?.warnings).toBe(1);
	if (observed && scenario === "empty-candidates") expect(log?.lastErrorCode).toBe("NO_CODE_FOUND");
	if (observed && scenario === "ambiguous-code") expect(log?.lastErrorCode).toBe("AMBIGUOUS_CODE");
	if (observed && scenario === "invalid-code-options")
		expect(log?.lastErrorCode).toBe("INVALID_STT_VERIFICATION_CODE_OPTIONS");
	if (observed && scenario === "usage")
		expect(log).toMatchObject({ durationMs: 1234, usage: 1234 });
	return {
		calls,
		result,
		error:
			error instanceof Error
				? {
						name: error.name,
						message: error.message,
						...("code" in error ? { code: error.code } : {}),
					}
				: error,
	};
}
describe("OCR telemetry behavior differential and one sample", () => {
	it.each([...ocrScenarios])("recorder off/on: %s", async (scenario) => {
		expect(await runOcr(scenario, true)).toEqual(await runOcr(scenario, false));
	});
});
describe("STT telemetry behavior differential and one sample", () => {
	it.each([...sttScenarios])("recorder off/on: %s", async (scenario) => {
		expect(await runStt(scenario, true)).toEqual(await runStt(scenario, false));
	});
});
