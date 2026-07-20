import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";

import { defineProvider } from "../define.js";
import { ProviderError, ValidationError } from "../errors.js";
import { createFlowContext } from "../runtime/auth-flow.js";
import {
	APIFUSE__STT__BACKEND_ENV,
	APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV,
	APIFUSE__STT__MODEL_ENV,
	CLOUDFLARE_ACCOUNT_ID_ENV,
	CLOUDFLARE_WORKERS_AI_STT_BACKEND,
	createCloudflareWorkersAiSttClient,
	createSttClientFromEnv,
	createUnsupportedSttClient,
	extractVerificationCode,
	resolveSttPrompt,
} from "../runtime/stt.js";
import { createServerApp } from "../server/serve.js";
import type { HttpClient, StealthClient, SttContext } from "../types.js";

const previousEnv = {
	backend: process.env[APIFUSE__STT__BACKEND_ENV],
	model: process.env[APIFUSE__STT__MODEL_ENV],
	accountId: process.env[CLOUDFLARE_ACCOUNT_ID_ENV],
	apiToken: process.env[APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV],
};

afterEach(() => {
	restoreEnv();
});

function restoreEnv() {
	for (const [key, value] of [
		[APIFUSE__STT__BACKEND_ENV, previousEnv.backend],
		[APIFUSE__STT__MODEL_ENV, previousEnv.model],
		[CLOUDFLARE_ACCOUNT_ID_ENV, previousEnv.accountId],
		[APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV, previousEnv.apiToken],
	] as const) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}

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

function minimalTls(): StealthClient {
	return {
		fetch: async () => {
			throw new Error("stealth unsupported");
		},
		createSession: () => {
			throw new Error("stealth unsupported");
		},
	};
}

describe("STT verification code extraction", () => {
	it("preserves leading zeros from Arabic digits", () => {
		expect(
			extractVerificationCode("인증번호는 012345 입니다", {
				codeLengths: [6],
			}).code,
		).toBe("012345");
	});

	it("parses English and Korean spoken digit words", () => {
		expect(extractVerificationCode("zero one two three", { codeLengths: [4] }).code).toBe("0123");
		expect(extractVerificationCode("공 일 이 삼", { codeLengths: [4] }).code).toBe("0123");
		expect(extractVerificationCode("영일이삼", { codeLengths: [4] }).code).toBe("0123");
	});

	it("parses mixed digit and word sequences", () => {
		const result = extractVerificationCode("코드는 0 일 2 삼", {
			codeLengths: [4],
		});

		expect(result.code).toBe("0123");
		expect(result.candidates[0]?.source).toBe("mixed");
	});

	it("filters by allowed code length", () => {
		expect(() => extractVerificationCode("code 1234", { codeLengths: [6] })).toThrow(ProviderError);
	});

	it("fails closed for ambiguous or missing candidates", () => {
		expect(() => extractVerificationCode("codes 1234 and 5678", { codeLengths: [4] })).toThrow(
			/Multiple verification code candidates/,
		);
		expect(() => extractVerificationCode("no code here", { codeLengths: [4] })).toThrow(
			/No verification code candidate/,
		);
	});

	it("rejects unsafe verification-code length options before allocating ranges", () => {
		expect(() =>
			extractVerificationCode("code 1234", {
				codeLengths: { min: 1, max: 99 },
			}),
		).toThrow(ValidationError);
		expect(() => extractVerificationCode("code 1234", { codeLengths: { min: 6, max: 4 } })).toThrow(
			ValidationError,
		);
		expect(() => extractVerificationCode("code 1234", { codeLengths: [4, 0] })).toThrow(
			ValidationError,
		);
	});
});

describe("STT prompt and runtime clients", () => {
	it("uses no prompt for general mode and a default hint for otp mode", () => {
		expect(
			resolveSttPrompt({
				audio: { kind: "base64", data: "AAAA" },
			}),
		).toBeUndefined();
		expect(
			resolveSttPrompt({
				audio: { kind: "base64", data: "AAAA" },
				mode: "otp",
			}),
		).toContain("Arabic numerals");
		expect(
			resolveSttPrompt({
				audio: { kind: "base64", data: "AAAA" },
				promptPolicy: "custom-hint",
				initialPrompt: "domain hint",
			}),
		).toBe("domain hint");
	});

	it("unsupported STT client fails explicitly without fake transcript success", async () => {
		await expect(
			createUnsupportedSttClient().transcribe({
				audio: { kind: "base64", data: "AAAA" },
			}),
		).rejects.toMatchObject({ code: "STT_UNAVAILABLE" });
	});

	it("does not enable live STT from env when provider did not declare STT", async () => {
		process.env[APIFUSE__STT__BACKEND_ENV] = CLOUDFLARE_WORKERS_AI_STT_BACKEND;
		process.env[CLOUDFLARE_ACCOUNT_ID_ENV] = "account-123";
		process.env[APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV] = "token-123";

		await expect(
			createSttClientFromEnv(undefined).transcribe({
				audio: { kind: "base64", data: "AAAA" },
			}),
		).rejects.toMatchObject({
			code: "STT_UNAVAILABLE",
			message: "Provider does not declare STT capability",
		});
	});

	it("rejects invalid base64 before calling Cloudflare", async () => {
		let called = false;
		const stt = createCloudflareWorkersAiSttClient({
			accountId: "acct",
			apiToken: "token",
			fetch: (async () => {
				called = true;
				return new Response("{}");
			}) as typeof fetch,
		});

		await expect(
			stt.transcribe({ audio: { kind: "base64", data: "not base64" } }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(called).toBe(false);
	});

	it("builds Cloudflare Workers AI REST request from env", async () => {
		process.env[APIFUSE__STT__BACKEND_ENV] = CLOUDFLARE_WORKERS_AI_STT_BACKEND;
		process.env[APIFUSE__STT__MODEL_ENV] = "@cf/openai/whisper-large-v3-turbo";
		process.env[CLOUDFLARE_ACCOUNT_ID_ENV] = "account-123";
		process.env[APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV] = "token-123";
		const originalFetch = global.fetch;
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		global.fetch = (async (input, init) => {
			calls.push({
				url: String(input),
				body: JSON.parse(String(init?.body)),
			});
			return Response.json({
				success: true,
				result: { text: "공 일 이 삼", language: "ko", segments: [] },
			});
		}) as typeof fetch;
		try {
			const stt = createSttClientFromEnv({ mode: "required" });
			const result = await stt.transcribe({
				audio: { kind: "base64", data: "AAAA" },
				language: "ko-KR",
				mode: "otp",
				verificationCode: { codeLengths: [4] },
			});

			expect(result.text).toBe("공 일 이 삼");
			expect(result.verificationCode?.code).toBe("0123");
			expect(calls[0]?.url).toContain(
				"/client/v4/accounts/account-123/ai/run/@cf/openai/whisper-large-v3-turbo",
			);
			expect(calls[0]?.body).toMatchObject({
				audio: "AAAA",
				language: "ko",
				task: "transcribe",
			});
			expect(String(calls[0]?.body.initial_prompt)).toContain("Arabic numerals");
		} finally {
			global.fetch = originalFetch;
		}
	});

	it("returns a warning when initialPrompt is supplied without custom-hint", async () => {
		const stt = createCloudflareWorkersAiSttClient({
			accountId: "acct",
			apiToken: "token",
			fetch: (async () =>
				Response.json({
					success: true,
					result: { text: "hello" },
				})) as typeof fetch,
		});

		const transcript = await stt.transcribe({
			audio: { kind: "base64", data: "AAAA" },
			initialPrompt: "ignored unless custom-hint",
		});

		expect(transcript.warnings?.[0]).toMatchObject({
			code: "UNSUPPORTED_STT_OPTION",
		});
	});

	it("maps Cloudflare fetch timeouts and network failures to transport errors", async () => {
		const timeoutError = new Error("aborted");
		timeoutError.name = "AbortError";
		const timeoutStt = createCloudflareWorkersAiSttClient({
			accountId: "acct",
			apiToken: "token",
			fetch: (async () => {
				throw timeoutError;
			}) as typeof fetch,
		});
		await expect(
			timeoutStt.transcribe({ audio: { kind: "base64", data: "AAAA" } }),
		).rejects.toMatchObject({ code: "transport_timeout", status: 0 });

		const networkStt = createCloudflareWorkersAiSttClient({
			accountId: "acct",
			apiToken: "token",
			fetch: (async () => {
				throw new Error("socket closed");
			}) as typeof fetch,
		});
		await expect(
			networkStt.transcribe({ audio: { kind: "base64", data: "AAAA" } }),
		).rejects.toMatchObject({
			code: "transport_network_error",
			status: 0,
		});
	});

	it("missing Cloudflare env resolves to STT_UNAVAILABLE", async () => {
		process.env[APIFUSE__STT__BACKEND_ENV] = CLOUDFLARE_WORKERS_AI_STT_BACKEND;
		delete process.env[CLOUDFLARE_ACCOUNT_ID_ENV];
		delete process.env[APIFUSE__STT__CLOUDFLARE_API_TOKEN_ENV];

		await expect(
			createSttClientFromEnv({ mode: "required" }).transcribe({
				audio: { kind: "base64", data: "AAAA" },
			}),
		).rejects.toMatchObject({ code: "STT_UNAVAILABLE" });
		await expect(
			createSttClientFromEnv({ mode: "optional" }).transcribe({
				audio: { kind: "base64", data: "AAAA" },
			}),
		).rejects.toMatchObject({ code: "STT_UNAVAILABLE" });
	});
});

describe("STT Provider SDK context integration", () => {
	it("defineProvider preserves STT capability declaration", () => {
		const provider = defineProvider({
			id: "stt-demo",
			version: "1.0.0",
			runtime: "standard",
			stt: { mode: "required" },
			meta: { displayName: "STT Demo", category: "test" },
			operations: {
				transcribe: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					handler: async () => ({ ok: true }),
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		});

		expect(provider.stt?.mode).toBe("required");
	});

	it("createFlowContext exposes an unsupported STT stub by default", async () => {
		const context = createFlowContext({
			http: minimalHttp(),
			stealth: minimalTls(),
			env: { get: () => undefined },
			tenantId: "tenant-1",
			providerId: "stt-demo",
			allowedKeys: [],
		});

		await expect(
			context.stt.transcribe({ audio: { kind: "base64", data: "AAAA" } }),
		).rejects.toMatchObject({ code: "STT_UNAVAILABLE" });
	});

	it("provider server injects STT override into operation and auth contexts", async () => {
		const stt: SttContext = {
			async transcribe() {
				return { text: "0123" };
			},
			extractVerificationCode,
		};
		const provider = defineProvider({
			id: "stt-server-demo",
			version: "1.0.0",
			runtime: "standard",
			stt: { mode: "required" },
			meta: { displayName: "STT Server Demo", category: "test" },
			context: { keys: [] },
			auth: {
				mode: "credentials",
				flow: {
					async start(ctx) {
						const transcript = await ctx.stt.transcribe({
							audio: { kind: "base64", data: "AAAA" },
						});
						return {
							kind: "message",
							turnId: "turn-1",
							data: { text: transcript.text },
						};
					},
					async continue() {
						return { kind: "complete", turnId: "turn-2" };
					},
				},
			},
			operations: {
				transcribe: {
					input: z.object({}),
					output: z.object({ text: z.string() }),
					async handler(ctx) {
						const transcript = await ctx.stt.transcribe({
							audio: { kind: "base64", data: "AAAA" },
						});
						return { text: transcript.text };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		});
		const app = createServerApp(provider, { stt });

		const operationResponse = await app.request("/v1/transcribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-1", input: {} }),
		});
		expect(await operationResponse.json()).toEqual({ data: { text: "0123" } });

		const authResponse = await app.request("/auth/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: "auth-req-1",
				flowId: "flow-1",
				tenantId: "tenant-1",
				providerId: "stt-server-demo",
			}),
		});
		expect(await authResponse.json()).toMatchObject({
			data: { data: { text: "0123" } },
		});
	});

	it("provider server maps missing required STT config to runtime-unavailable status", async () => {
		const provider = defineProvider({
			id: "stt-unavailable-demo",
			version: "1.0.0",
			runtime: "standard",
			stt: { mode: "required" },
			meta: { displayName: "STT Unavailable Demo", category: "test" },
			operations: {
				transcribe: {
					input: z.object({}),
					output: z.object({ ok: z.boolean() }),
					async handler(ctx) {
						await ctx.stt.transcribe({
							audio: { kind: "base64", data: "AAAA" },
						});
						return { ok: true };
					},
					healthCheckUnsupported: { reason: "unit test" },
				},
			},
		});
		const app = createServerApp(provider, { logger: () => undefined });

		const response = await app.request("/v1/transcribe", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requestId: "req-stt-missing", input: {} }),
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "STT_UNAVAILABLE" },
		});
	});
});
