import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../errors.js";
import type { ProviderChallenge, ProviderChallengeKind } from "../../types.js";
import { createTwoCaptchaResolverVendorAdapter } from "../resolver-vendors/twocaptcha.js";
import { ResolverVendorUnavailableError } from "../resolver-vendors/types.js";
import { createTraceContext, getTraceRecorder } from "../trace.js";

const RECAPTCHA_CHALLENGE = {
	kind: "recaptcha_v2",
	siteKey: "site-key",
	pageUrl: "https://example.com/protected",
} satisfies ProviderChallenge;

const ALL_DECLARED_KINDS = [
	"turnstile",
	"recaptcha_v2",
	"recaptcha_v3",
	"hcaptcha",
	"cloudflare_interstitial",
	"aws_waf",
	"akamai_sec_cpt",
	"akamai_sensor",
] as const satisfies readonly ProviderChallengeKind[];

const UNIMPLEMENTED_CHALLENGES = [
	{ kind: "turnstile", siteKey: "site-key", pageUrl: RECAPTCHA_CHALLENGE.pageUrl },
	{
		kind: "recaptcha_v3",
		siteKey: "site-key",
		pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
		action: "submit",
	},
	{ kind: "hcaptcha", siteKey: "site-key", pageUrl: RECAPTCHA_CHALLENGE.pageUrl },
	{ kind: "cloudflare_interstitial", pageUrl: RECAPTCHA_CHALLENGE.pageUrl },
	{ kind: "aws_waf", pageUrl: RECAPTCHA_CHALLENGE.pageUrl },
	{ kind: "akamai_sec_cpt", pageUrl: RECAPTCHA_CHALLENGE.pageUrl },
	{
		kind: "akamai_sensor",
		pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
		scriptUrl: "https://example.com/akamai/sensor.js",
	},
] as const satisfies readonly ProviderChallenge[];

type FetchCall = {
	readonly url: string;
	readonly init: RequestInit | undefined;
	readonly body: Record<string, unknown>;
};

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function createFetchStub(responses: readonly (Response | Error)[]) {
	const calls: FetchCall[] = [];
	let responseIndex = 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
		calls.push({ url: String(input), init, body });
		const response = responses[responseIndex];
		responseIndex += 1;
		if (!response) throw new Error("Unexpected fetch call");
		if (response instanceof Error) throw response;
		return response;
	}) as typeof fetch;
	return { calls, fetchImpl };
}

function createAdapter(
	stub: ReturnType<typeof createFetchStub>,
	overrides: Partial<Parameters<typeof createTwoCaptchaResolverVendorAdapter>[0]> = {},
) {
	return createTwoCaptchaResolverVendorAdapter({
		allowedHosts: ["example.com"],
		apiKey: "test-api-key",
		baseUrl: "https://solver.test/api",
		delay: async () => undefined,
		fetchImpl: stub.fetchImpl,
		pollIntervalMs: 3_000,
		timeoutMs: 180_000,
		...overrides,
	});
}

function successfulFetch(solution: Record<string, unknown>) {
	return createFetchStub([
		jsonResponse({ errorId: 0, taskId: 42 }),
		jsonResponse({ errorId: 0, status: "ready", solution }),
	]);
}

async function capturedError(operation: Promise<unknown>): Promise<unknown> {
	return await operation.catch((error: unknown) => error);
}

describe("2captcha resolver vendor", () => {
	it("records one create-task span and one whole-loop poll span in order", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: 42 }),
			jsonResponse({ errorId: 0, status: "processing" }),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { gRecaptchaResponse: "traced-token" },
			}),
		]);
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");

		await expect(
			createAdapter(stub).solve(
				RECAPTCHA_CHALLENGE,
				undefined,
				new AbortController().signal,
				recorder,
			),
		).resolves.toEqual({ form: "token", token: "traced-token" });

		expect(trace.getSpans()).toHaveLength(2);
		expect(trace.getSpans()).toEqual([
			expect.objectContaining({
				name: "resolver.vendor.create_task",
				status: "ok",
				attributes: expect.objectContaining({
					vendor: "2captcha",
					challenge_kind: "recaptcha_v2",
				}),
			}),
			expect.objectContaining({
				name: "resolver.vendor.poll_result",
				status: "ok",
				attributes: expect.objectContaining({
					vendor: "2captcha",
					challenge_kind: "recaptcha_v2",
				}),
			}),
		]);
		expect(stub.calls).toHaveLength(3);
	});

	it("records a failed create-task span without starting a poll span", async () => {
		const networkError = new Error("connection reset");
		const stub = createFetchStub([networkError]);
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");

		const error = await capturedError(
			createAdapter(stub).solve(
				RECAPTCHA_CHALLENGE,
				undefined,
				new AbortController().signal,
				recorder,
			),
		);
		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "2captcha",
			reason: "transport_failure",
			phase: "create_task",
		});
		expect((error as Error).cause).toBe(networkError);
		expect(trace.getSpans()).toHaveLength(1);
		expect(trace.getSpans()[0]).toMatchObject({
			name: "resolver.vendor.create_task",
			status: "error",
			attributes: {
				vendor: "2captcha",
				challenge_kind: "recaptcha_v2",
				unavailability_reason: "transport_failure",
				transport_phase: "create_task",
			},
		});
	});

	it("solves through multiple poll iterations without a trace recorder", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: 42 }),
			jsonResponse({ errorId: 0, status: "processing" }),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { gRecaptchaResponse: "untraced-token" },
			}),
		]);

		await expect(
			createAdapter(stub).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		).resolves.toEqual({ form: "token", token: "untraced-token" });
		expect(stub.calls).toHaveLength(3);
	});

	it("keeps secret material out of recorded span attributes", async () => {
		const apiKey = "span-api-key-secret";
		const proxyUrl = "http://span-user:span-password@proxy.example:8080";
		const stub = createFetchStub([
			jsonResponse({
				errorId: 1,
				errorCode: "ERROR_TASK_ABSENT",
				errorDescription: `${apiKey} ${proxyUrl}`,
			}),
		]);
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");

		await capturedError(
			createAdapter(stub, { apiKey }).solve(
				RECAPTCHA_CHALLENGE,
				{ proxyUrl, userAgent: "Browser/1.0" },
				new AbortController().signal,
				recorder,
			),
		);

		expect(trace.getSpans()).toHaveLength(1);
		const recordedAttributes = JSON.stringify(trace.getSpans().map((span) => span.attributes));
		for (const secret of [apiKey, proxyUrl, "span-user", "span-password"]) {
			expect(recordedAttributes).not.toContain(secret);
		}
	});

	it("creates a proxyless reCAPTCHA v2 task and returns its response token", async () => {
		const stub = successfulFetch({ gRecaptchaResponse: "recaptcha-token" });
		const adapter = createAdapter(stub);

		const result = await adapter.solve(
			RECAPTCHA_CHALLENGE,
			undefined,
			new AbortController().signal,
		);

		expect(result).toEqual({ form: "token", token: "recaptcha-token" });
		expect(stub.calls.map((call) => call.url)).toEqual([
			"https://solver.test/api/createTask",
			"https://solver.test/api/getTaskResult",
		]);
		expect(stub.calls[0]?.body).toEqual({
			clientKey: "test-api-key",
			task: {
				type: "RecaptchaV2TaskProxyless",
				websiteURL: RECAPTCHA_CHALLENGE.pageUrl,
				websiteKey: RECAPTCHA_CHALLENGE.siteKey,
				isInvisible: false,
			},
		});
		expect(stub.calls[1]?.body).toEqual({ clientKey: "test-api-key", taskId: 42 });
	});

	it("creates a proxied task from the supplied resolver identity", async () => {
		const stub = successfulFetch({ gRecaptchaResponse: "proxied-token" });
		const adapter = createAdapter(stub);

		await adapter.solve(
			RECAPTCHA_CHALLENGE,
			{
				proxyUrl: "socks5://proxy-user:proxy-password@proxy.example:1080",
				userAgent: "Measured Browser/1.0",
			},
			new AbortController().signal,
		);

		expect(stub.calls[0]?.body).toMatchObject({
			task: {
				type: "RecaptchaV2Task",
				websiteURL: RECAPTCHA_CHALLENGE.pageUrl,
				websiteKey: RECAPTCHA_CHALLENGE.siteKey,
				proxyType: "socks5",
				proxyAddress: "proxy.example",
				proxyPort: 1080,
				proxyLogin: "proxy-user",
				proxyPassword: "proxy-password",
				userAgent: "Measured Browser/1.0",
			},
		});
	});

	it("falls back to solution.token when gRecaptchaResponse is absent", async () => {
		const stub = successfulFetch({ token: "fallback-token" });

		await expect(
			createAdapter(stub).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		).resolves.toEqual({ form: "token", token: "fallback-token" });
	});

	it.each([
		{ gRecaptchaResponse: "" },
		{ token: "" },
	])("rejects an empty token instead of returning a non-solution: %o", async (solution) => {
		const error = await capturedError(
			createAdapter(successfulFetch(solution)).solve(
				RECAPTCHA_CHALLENGE,
				undefined,
				new AbortController().signal,
			),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({ vendor: "2captcha", reason: "transport_failure" });
	});

	it("reports missing credentials without attempting a request", async () => {
		const stub = createFetchStub([]);
		const error = await capturedError(
			createAdapter(stub, { apiKey: " \t " }).solve(
				RECAPTCHA_CHALLENGE,
				undefined,
				new AbortController().signal,
			),
		);

		expect(error).toMatchObject({ vendor: "2captcha", reason: "missing_credentials" });
		expect(stub.calls).toHaveLength(0);
	});

	it.each(
		UNIMPLEMENTED_CHALLENGES,
	)("reports $kind as not implemented without attempting a request", async (challenge) => {
		const stub = createFetchStub([]);
		const error = await capturedError(
			createAdapter(stub).solve(challenge, undefined, new AbortController().signal),
		);

		expect(error).toMatchObject({ vendor: "2captcha", reason: "not_implemented" });
		expect(stub.calls).toHaveLength(0);
	});

	it("reads support for all eight kinds from the declared capability table", () => {
		const adapter = createAdapter(createFetchStub([]));

		expect(
			Object.fromEntries(ALL_DECLARED_KINDS.map((kind) => [kind, adapter.supports(kind)])),
		).toEqual(Object.fromEntries(ALL_DECLARED_KINDS.map((kind) => [kind, true])));
	});

	it("throws TypeError for a kind outside the declared capability table", async () => {
		const challenge = {
			kind: "future_challenge",
			pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
		} as unknown as ProviderChallenge;

		await expect(
			createAdapter(createFetchStub([])).solve(challenge, undefined, new AbortController().signal),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("rejects an undeclared challenge host before calling 2captcha", async () => {
		const stub = createFetchStub([]);
		const error = await capturedError(
			createAdapter(stub).solve(
				{ ...RECAPTCHA_CHALLENGE, pageUrl: "https://undeclared.example/protected" },
				undefined,
				new AbortController().signal,
			),
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({ code: "RESOLVER_HOST_NOT_ALLOWED" });
		expect(stub.calls).toHaveLength(0);
	});

	it("maps an elapsed polling ceiling to timeout without sleeping", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-1" }),
			jsonResponse({ errorId: 0, status: "processing" }),
		]);
		let now = 0;
		const error = await capturedError(
			createAdapter(stub, {
				delay: async (ms) => {
					now += ms;
				},
				now: () => now,
				pollIntervalMs: 3,
				timeoutMs: 5,
			}).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toMatchObject({ vendor: "2captcha", reason: "timeout" });
		expect(stub.calls).toHaveLength(2);
	});

	it("maps a vendor task error to transport failure", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 1, errorCode: "ERROR_TASK_ABSENT", taskId: 42 }),
		]);

		await expect(
			createAdapter(stub).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		).rejects.toMatchObject({ vendor: "2captcha", reason: "transport_failure" });
		expect(stub.calls).toHaveLength(1);
	});

	it("maps an HTTP failure to transport failure", async () => {
		const stub = createFetchStub([jsonResponse({ errorId: 0, taskId: 42 }, 503)]);

		await expect(
			createAdapter(stub).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		).rejects.toMatchObject({ vendor: "2captcha", reason: "transport_failure" });
		expect(stub.calls).toHaveLength(1);
	});

	it("refuses redirects for credential-bearing task requests", async () => {
		const stub = createFetchStub([jsonResponse({ errorId: 0, taskId: 42 }, 307)]);

		await expect(
			createAdapter(stub).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		).rejects.toBeInstanceOf(ResolverVendorUnavailableError);
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.init?.redirect).toBe("error");
	});

	it("preserves the create-task network failure cause and phase", async () => {
		const networkError = new Error("connection reset");
		const stub = createFetchStub([networkError]);
		const error = await capturedError(
			createAdapter(stub).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "2captcha",
			reason: "transport_failure",
			phase: "create_task",
		});
		expect((error as Error).cause).toBe(networkError);
	});

	it("preserves the polling network failure cause and phase", async () => {
		const networkError = new Error("TLS handshake failed");
		const stub = createFetchStub([jsonResponse({ errorId: 0, taskId: 42 }), networkError]);
		const error = await capturedError(
			createAdapter(stub).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "2captcha",
			reason: "transport_failure",
			phase: "poll_result",
		});
		expect((error as Error).cause).toBe(networkError);
	});

	it("maps a zero-balance vendor response to allocation exhaustion", async () => {
		const stub = createFetchStub([
			jsonResponse({
				errorId: 10,
				errorCode: "ERROR_ZERO_BALANCE",
				errorDescription: "Account has zero funds",
			}),
		]);

		await expect(
			createAdapter(stub).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		).rejects.toMatchObject({ vendor: "2captcha", reason: "allocation_exhausted" });
	});

	it("stops promptly when aborted during the polling delay", async () => {
		const stub = createFetchStub([jsonResponse({ errorId: 0, taskId: 42 })]);
		const controller = new AbortController();
		const abort = new DOMException("caller stopped", "AbortError");
		const adapter = createAdapter(stub, {
			delay: async () => {
				controller.abort(abort);
			},
		});

		await expect(adapter.solve(RECAPTCHA_CHALLENGE, undefined, controller.signal)).rejects.toBe(
			abort,
		);
		expect(stub.calls).toHaveLength(1);
	});

	it("does not expose API-key or proxy secrets in typed failures", async () => {
		const apiKey = "key-secret-substring";
		const proxyUrl = "http://proxy-user:proxy-password@proxy.example:8080";
		const stub = createFetchStub([
			jsonResponse({
				errorId: 1,
				errorCode: "ERROR_TASK_ABSENT",
				errorDescription: `${apiKey} ${proxyUrl}`,
			}),
		]);
		const error = await capturedError(
			createAdapter(stub, { apiKey }).solve(
				RECAPTCHA_CHALLENGE,
				{ proxyUrl, userAgent: "Browser/1.0" },
				new AbortController().signal,
			),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		for (const secret of [apiKey, proxyUrl, "proxy-password"]) {
			expect((error as Error).message).not.toContain(secret);
			expect(String(error)).not.toContain(secret);
			expect(String((error as Error).cause ?? "")).not.toContain(secret);
		}
	});
});
