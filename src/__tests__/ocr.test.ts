import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../define.js";
import { ProviderError } from "../errors.js";
import { createFlowContext } from "../runtime/auth-flow.js";
import {
	APIFUSE__OCR__API_KEY_ENV,
	APIFUSE__OCR__BACKEND_ENV,
	APIFUSE__OCR__BASE_URL_ENV,
	APIFUSE__OCR__CLOUDFLARE_API_TOKEN_ENV,
	APIFUSE__OCR__MODEL_ENV,
	CLOUDFLARE_ACCOUNT_ID_ENV,
	createCloudflareWorkersAiOcrClient,
	createOcrClientFromEnv,
	createOpenAiCompatibleOcrClient,
	createUnsupportedOcrClient,
	DEFAULT_CLOUDFLARE_WORKERS_AI_OCR_MODEL,
	extractCaptchaCandidates,
	OPENAI_COMPATIBLE_OCR_BACKEND,
} from "../runtime/ocr.js";
import { createServerApp } from "../server/serve.js";
import type { HttpClient, OcrContext, StealthClient } from "../types.js";

const image = { kind: "base64", data: "aW1hZ2U=", mediaType: "image/png" } as const;

function minimalHttp(): HttpClient {
	const bodyBytes = new Uint8Array();
	const response = async () => ({
		status: 200,
		ok: true,
		headers: {},
		data: {},
		json: async <T = unknown>() => ({}) as T,
		text: async () => "",
		arrayBuffer: async () => bodyBytes.buffer.slice(0),
		bytes: async () => bodyBytes.slice(0),
	});
	return {
		request: response,
		get: response,
		post: response,
		put: response,
		delete: response,
		stream: async () => {
			throw new Error("stream unsupported");
		},
		sse: async () => {
			throw new Error("sse unsupported");
		},
	};
}

function minimalStealth(): StealthClient {
	return {
		fetch: async () => {
			throw new Error("stealth unsupported");
		},
		createSession: () => {
			throw new Error("stealth unsupported");
		},
	};
}

function cloudflareResponse(text: string): Response {
	return Response.json({
		success: true,
		result: { choices: [{ message: { content: text } }] },
	});
}

describe("OCR runtime clients", () => {
	it("selects the default Cloudflare backend and default measured model from env", async () => {
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const originalFetch = global.fetch;
		global.fetch = (async (input, init) => {
			calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
			return cloudflareResponse("visible text");
		}) as typeof fetch;
		try {
			const ocr = createOcrClientFromEnv(
				{ mode: "required" },
				{
					[CLOUDFLARE_ACCOUNT_ID_ENV]: "account-123",
					[APIFUSE__OCR__CLOUDFLARE_API_TOKEN_ENV]: "token-123",
				},
			);
			const result = await ocr.recognize({ image });

			expect(result).toEqual({
				text: "visible text",
				model: DEFAULT_CLOUDFLARE_WORKERS_AI_OCR_MODEL,
			});
			expect(calls[0]?.url).toEndWith(`/ai/run/${DEFAULT_CLOUDFLARE_WORKERS_AI_OCR_MODEL}`);
			expect(calls[0]?.body.chat_template_kwargs).toEqual({ enable_thinking: false });
		} finally {
			global.fetch = originalFetch;
		}
	});

	it("selects the openai-compatible backend without appending /v1", async () => {
		const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
		const originalFetch = global.fetch;
		global.fetch = (async (input, init) => {
			calls.push({ url: String(input), headers: init?.headers });
			return Response.json({ choices: [{ message: { content: "self hosted" } }] });
		}) as typeof fetch;
		try {
			const ocr = createOcrClientFromEnv(
				{ mode: "optional" },
				{
					[APIFUSE__OCR__BACKEND_ENV]: OPENAI_COMPATIBLE_OCR_BACKEND,
					[APIFUSE__OCR__BASE_URL_ENV]: "http://ocr.internal/v1",
					[APIFUSE__OCR__API_KEY_ENV]: "secret",
					[APIFUSE__OCR__MODEL_ENV]: "zai-org/GLM-OCR",
				},
			);
			expect((await ocr.recognize({ image })).text).toBe("self hosted");
			expect(calls[0]?.url).toBe("http://ocr.internal/v1/chat/completions");
			expect(calls[0]?.headers).toMatchObject({ Authorization: "Bearer secret" });
		} finally {
			global.fetch = originalFetch;
		}
	});

	it("fails closed when the openai-compatible backend has no configured model", async () => {
		const ocr = createOcrClientFromEnv(
			{ mode: "optional" },
			{
				[APIFUSE__OCR__BACKEND_ENV]: OPENAI_COMPATIBLE_OCR_BACKEND,
				[APIFUSE__OCR__BASE_URL_ENV]: "http://ocr.internal/v1",
			},
		);

		try {
			await ocr.recognize({ image });
			throw new Error("expected OCR recognition to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderError);
			expect(error).toMatchObject({
				code: "OCR_UNAVAILABLE",
				message: `OCR backend ${OPENAI_COMPATIBLE_OCR_BACKEND} requires ${APIFUSE__OCR__MODEL_ENV}`,
			});
			expect((error as ProviderError).fix).toContain(APIFUSE__OCR__MODEL_ENV);
			expect((error as ProviderError).fix).toContain("zai-org/GLM-OCR");
		}
	});

	it("sends a supplied self-hosted model ID verbatim", async () => {
		let body: Record<string, unknown> | undefined;
		const model = "zai-org/GLM-OCR";
		const ocr = createOpenAiCompatibleOcrClient({
			baseUrl: "http://ocr.internal/v1",
			model,
			fetch: (async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return Response.json({ choices: [{ message: { content: "abc123" } }] });
			}) as typeof fetch,
		});

		await ocr.recognize({ image });

		expect(body?.model).toBe(model);
	});

	it("fails closed for undeclared OCR and missing backend credentials", async () => {
		await expect(
			createOcrClientFromEnv(undefined, {
				[CLOUDFLARE_ACCOUNT_ID_ENV]: "account-123",
				[APIFUSE__OCR__CLOUDFLARE_API_TOKEN_ENV]: "token-123",
			}).recognize({ image }),
		).rejects.toMatchObject({
			code: "OCR_UNAVAILABLE",
			message: "Provider does not declare OCR capability",
		});
		await expect(
			createOcrClientFromEnv({ mode: "required" }, {}).recognize({ image }),
		).rejects.toMatchObject({ code: "OCR_UNAVAILABLE" });
		await expect(
			createOcrClientFromEnv(
				{ mode: "optional" },
				{ [APIFUSE__OCR__BACKEND_ENV]: OPENAI_COMPATIBLE_OCR_BACKEND },
			).recognize({ image }),
		).rejects.toMatchObject({ code: "OCR_UNAVAILABLE" });
	});

	it("unsupported OCR client throws on every method without fake success", async () => {
		const ocr = createUnsupportedOcrClient();
		await expect(ocr.recognize({ image })).rejects.toMatchObject({ code: "OCR_UNAVAILABLE" });
		await expect(ocr.extractCaptchaText(image)).rejects.toMatchObject({
			code: "OCR_UNAVAILABLE",
		});
	});

	it("adds the required gemma thinking-disabled payload option", async () => {
		let body: Record<string, unknown> | undefined;
		const ocr = createCloudflareWorkersAiOcrClient({
			accountId: "account",
			apiToken: "token",
			model: "@cf/google/gemma-4-26b-a4b-it",
			fetch: (async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return cloudflareResponse("abc123");
			}) as typeof fetch,
		});

		await ocr.recognize({ image, hint: "captcha" });
		expect(body?.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(body?.max_tokens).toBe(64);
	});

	it("streams moondream and returns the cumulative answer from the stop chunk", async () => {
		let body: Record<string, unknown> | undefined;
		const sse = [
			'data: {"chunk":{"answer":"a","finish_reason":null}}',
			'data: {"chunk":{"answer":"aB3","finish_reason":null}}',
			'data: {"chunk":{"answer":"aB3dEf78","finish_reason":"stop"}}',
			"data: [DONE]",
			"",
		].join("\n");
		const ocr = createCloudflareWorkersAiOcrClient({
			accountId: "account",
			apiToken: "token",
			model: "@cf/moondream/moondream3.1-9B-A2B",
			fetch: (async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
			}) as typeof fetch,
		});

		expect((await ocr.recognize({ image, hint: "captcha" })).text).toBe("aB3dEf78");
			expect(body).toMatchObject({
				task: "query",
				stream: true,
				reasoning: false,
				temperature: 0,
				max_tokens: 64,
			});
		expect(typeof body?.image).toBe("string");
		expect(typeof body?.question).toBe("string");
	});

	it("gives kimi enough tokens and does not try to disable thinking", async () => {
		let body: Record<string, unknown> | undefined;
		const ocr = createCloudflareWorkersAiOcrClient({
			accountId: "account",
			apiToken: "token",
			model: "@cf/moonshotai/kimi-k2.7-code",
			fetch: (async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return cloudflareResponse("abc123");
			}) as typeof fetch,
		});

		await ocr.recognize({ image, maxTokens: 100 });
		expect(Number(body?.max_tokens)).toBeGreaterThanOrEqual(3_000);
		expect(body).not.toHaveProperty("chat_template_kwargs");
	});

	it("throws ProviderError for an empty model response", async () => {
		const ocr = createOpenAiCompatibleOcrClient({
			baseUrl: "http://ocr.internal",
			model: "unknown-vision-model",
			fetch: (async () =>
				Response.json({ choices: [{ message: { content: "" } }] })) as typeof fetch,
		});

		try {
			await ocr.recognize({ image });
			throw new Error("expected OCR recognition to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderError);
			expect(error).toMatchObject({ code: "OCR_UPSTREAM_FAILED" });
		}
	});

	it("extracts CAPTCHA text with one model call and reports primary constraints", async () => {
		let calls = 0;
		const ocr = createOpenAiCompatibleOcrClient({
			baseUrl: "http://ocr.internal",
			model: "vision-model",
			fetch: (async () => {
				calls += 1;
				return Response.json({
					choices: [{ message: { content: "The characters are: aB3dEf78." } }],
				});
			}) as typeof fetch,
		});

		const result = await ocr.extractCaptchaText(image, {
			length: 8,
			charset: /^[A-Za-z0-9]+$/,
		});

		expect(calls).toBe(1);
		expect(result).toMatchObject({
			text: "aB3dEf78",
			satisfiesConstraints: true,
			model: "vision-model",
		});
	});
});

describe("OCR CAPTCHA constraint handling", () => {
	it("normalizes chatter and reports length and charset passes and failures", () => {
		const passing = extractCaptchaCandidates(" The characters are: `aB3dEf78`. ", {
			length: 8,
			charset: /^[A-Za-z0-9]+$/,
		});
		expect(passing[0]).toEqual({ text: "aB3dEf78", satisfiesConstraints: true });

		expect(extractCaptchaCandidates("abc", { length: 4 })[0]?.satisfiesConstraints).toBe(false);
		expect(
			extractCaptchaCandidates("abc-123", { charset: "abcdefghijklmnopqrstuvwxyz0123456789" })[0]
				?.satisfiesConstraints,
		).toBe(false);
	});

	it("compares charset case-insensitively without rewriting recognized text", () => {
		const result = extractCaptchaCandidates("AbC", {
			length: 3,
			charset: "abc",
			caseSensitive: false,
		});

		expect(result[0]).toEqual({ text: "AbC", satisfiesConstraints: true });
	});

	it("rejects embedded forbidden characters with an unanchored charset RegExp", () => {
		const result = extractCaptchaCandidates("ab!!cd12", {
			charset: /[A-Za-z0-9]/,
			maxCandidates: 1,
		});

		expect(result[0]).toEqual({ text: "ab!!cd12", satisfiesConstraints: false });
	});

	it("resets global charset RegExp state for every character", () => {
		for (const modelText of ["ABC", "CBA"]) {
			expect(
				extractCaptchaCandidates(modelText, { charset: /[A-Z]/g, maxCandidates: 1 })[0]
					?.satisfiesConstraints,
			).toBe(true);
		}
	});

	it("treats string and RegExp charsets equivalently", () => {
		const stringCharset = "abcdefghijklmnopqrstuvwxyz0123456789";
		const regexCharset = /[a-z0-9]/;

		for (const modelText of ["abcd1234", "ab!!cd12"]) {
			const stringResult = extractCaptchaCandidates(modelText, {
				charset: stringCharset,
				maxCandidates: 1,
			});
			const regexResult = extractCaptchaCandidates(modelText, {
				charset: regexCharset,
				maxCandidates: 1,
			});

			expect(regexResult[0]?.satisfiesConstraints).toBe(
				stringResult[0]?.satisfiesConstraints,
			);
		}
	});

	it("adds ranked constraint-satisfying homoglyph alternatives and honors maxCandidates", () => {
		const candidates = extractCaptchaCandidates("I0", {
			length: 2,
			charset: "0123456789",
			maxCandidates: 2,
		});

		expect(candidates).toEqual([
			{ text: "I0", satisfiesConstraints: false },
			{ text: "10", satisfiesConstraints: true },
		]);
		expect(
			extractCaptchaCandidates("I0", {
				charset: "0123456789",
				maxCandidates: 1,
			}),
		).toHaveLength(1);
	});

	it("keeps homoglyph membership type-safe in the OCR source", async () => {
		const source = await Bun.file(new URL("../runtime/ocr.ts", import.meta.url)).text();

		expect(source).not.toContain("as never");
		expect(
			extractCaptchaCandidates("I0", {
				length: 2,
				charset: "0123456789",
				maxCandidates: 2,
			})[1]?.text,
		).toBe("10");
	});

	it("returns immediately when homoglyph substitutions cannot repair length", () => {
		const start = performance.now();
		const candidates = extractCaptchaCandidates("IlOoSsZzBIlOo", {
			length: 14,
			maxCandidates: 3,
		});
		const elapsedMs = performance.now() - start;

		expect(candidates).toEqual([
			{ text: "IlOoSsZzBIlOo", satisfiesConstraints: false },
		]);
		expect(elapsedMs).toBeLessThan(200);
	});

	it("caps homoglyph exploration for a long charset-failing input", () => {
		const modelText = "IlOoSsZzB".repeat(12);
		const start = performance.now();
		const candidates = extractCaptchaCandidates(modelText, {
			charset: "x",
			maxCandidates: 3,
		});
		const elapsedMs = performance.now() - start;

		expect(candidates).toEqual([{ text: modelText, satisfiesConstraints: false }]);
		expect(elapsedMs).toBeLessThan(200);
	});
});

describe("OCR Provider SDK context integration", () => {
	it("defineProvider preserves the OCR capability declaration", () => {
		const provider = defineProvider({
			id: "ocr-demo",
			version: "1.0.0",
			runtime: "standard",
			ocr: { mode: "required" },
			meta: { displayName: "OCR Demo", category: "test" },
			operations: {
				recognize: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async () => ({ ok: true }),
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		});

		expect(provider.ocr?.mode).toBe("required");
	});

	it("defineProvider validates OCR declaration shape and mode", () => {
		const base = {
			id: "ocr-invalid-demo",
			version: "1.0.0",
			runtime: "standard",
			meta: { displayName: "OCR Invalid Demo", category: "test" },
			operations: {
				recognize: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async () => ({ ok: true }),
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		} as const;

		expect(() => defineProvider({ ...base, ocr: true } as never)).toThrow(
			/invalid ocr: must be an object/,
		);
		expect(() => defineProvider({ ...base, ocr: { mode: "sometimes" } } as never)).toThrow(
			/ocr.mode/,
		);
	});

	it("createFlowContext exposes an unsupported OCR stub by default", async () => {
		const context = createFlowContext({
			http: minimalHttp(),
			stealth: minimalStealth(),
			env: { get: () => undefined },
			tenantId: "tenant-1",
			providerId: "ocr-demo",
			allowedKeys: [],
		});

		await expect(context.ocr.recognize({ image })).rejects.toMatchObject({
			code: "OCR_UNAVAILABLE",
		});
	});

	it("provider server injects an OCR override into operation and auth contexts", async () => {
		const ocr: OcrContext = {
			async recognize() {
				return { text: "aB3dEf78", model: "test-model" };
			},
			async extractCaptchaText() {
				return {
					text: "aB3dEf78",
					candidates: [{ text: "aB3dEf78", satisfiesConstraints: true }],
					satisfiesConstraints: true,
					model: "test-model",
				};
			},
		};
		const provider = defineProvider({
			id: "ocr-server-demo",
			version: "1.0.0",
			runtime: "standard",
			ocr: { mode: "required" },
			meta: { displayName: "OCR Server Demo", category: "test" },
			context: { keys: [] },
			auth: {
				mode: "credentials",
				flow: {
					async start(ctx) {
						const result = await ctx.ocr.recognize({ image });
						return {
							kind: "message",
							turnId: "turn-1",
							data: { text: result.text },
						};
					},
					async continue() {
						return { kind: "complete", turnId: "turn-2" };
					},
				},
			},
			operations: {
				recognize: {
					input: z.object({}),
					output: z.object({ text: z.string() }),
					async handler(ctx) {
						return { text: (await ctx.ocr.recognize({ image })).text };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		});
		const app = createServerApp(provider, { ocr });

		const operationResponse = await app.request("/v1/recognize", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-1", input: {} }),
		});
		expect(await operationResponse.json()).toEqual({ data: { text: "aB3dEf78" } });

		const authResponse = await app.request("/auth/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: "auth-req-1",
				flowId: "flow-1",
				tenantId: "tenant-1",
				providerId: "ocr-server-demo",
			}),
		});
		expect(await authResponse.json()).toMatchObject({
			data: { data: { text: "aB3dEf78" } },
		});
	});

	it("maps missing required OCR config to runtime-unavailable status", async () => {
		const provider = defineProvider({
			id: "ocr-unavailable-demo",
			version: "1.0.0",
			runtime: "standard",
			ocr: { mode: "required" },
			meta: { displayName: "OCR Unavailable Demo", category: "test" },
			operations: {
				recognize: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler(ctx) {
						await ctx.ocr.recognize({ image });
						return { ok: true };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		});
		const app = createServerApp(provider, {
			logger: () => undefined,
			ocr: createOcrClientFromEnv({ mode: "required" }, {}),
		});

		const response = await app.request("/v1/recognize", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-ocr-missing", input: {} }),
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "OCR_UNAVAILABLE" },
		});
	});
});
