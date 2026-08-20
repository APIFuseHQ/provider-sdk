import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../errors.js";
import type { ChallengeSolution, ProviderChallenge, ProviderChallengeKind } from "../../types.js";
import { NODEMAVEN_PASSWORD_ENV, NODEMAVEN_USERNAME_ENV } from "../proxy-nodemaven.js";
import { createResolverClient } from "../resolver.js";
import { createTwoCaptchaResolverVendorAdapter } from "../resolver-vendors/twocaptcha.js";
import {
	ResolverChallengeVerdictError,
	type ResolverVendorAdapter,
	ResolverVendorUnavailableError,
} from "../resolver-vendors/types.js";
import { RESOLVER_VENDOR_CAPABILITIES } from "../resolver-vendors/types.js";
import { createTraceContext, getTraceRecorder } from "../trace.js";

const RECAPTCHA_CHALLENGE = {
	kind: "recaptcha_v2",
	siteKey: "site-key",
	pageUrl: "https://example.com/protected",
} satisfies ProviderChallenge;

const AWS_WAF_CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://example.com/protected",
	siteKey: "goku-key",
	captchaScript: "https://waf.example/challenge.js",
	context: "goku-context",
	iv: "goku-iv",
} satisfies ProviderChallenge;

const UNSUPPORTED_CHALLENGES = [
	{ kind: "cloudflare_interstitial", pageUrl: RECAPTCHA_CHALLENGE.pageUrl },
	{ kind: "akamai_sec_cpt", pageUrl: RECAPTCHA_CHALLENGE.pageUrl },
	{ kind: "akamai_sensor", pageUrl: RECAPTCHA_CHALLENGE.pageUrl, scriptUrl: "https://example.com/akamai/sensor.js" },
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

function createTwoVendorChain(
	first: ResolverVendorAdapter,
	secondBehavior: () => Promise<ChallengeSolution> = async () => ({
		form: "token",
		token: "second-vendor-token",
	}),
) {
	let secondCalls = 0;
	const second: ResolverVendorAdapter = {
		id: "custom",
		supports: (kind) => kind === "aws_waf",
		async solve() {
			secondCalls += 1;
			return await secondBehavior();
		},
	};
	return {
		client: createResolverClient({ adapters: [first, second], kinds: ["aws_waf"] }),
		secondCalls: () => secondCalls,
	};
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

	it.each([
		{
			challenge: { kind: "turnstile", siteKey: "ts-key", pageUrl: RECAPTCHA_CHALLENGE.pageUrl, action: "managed", cdata: "data" } satisfies ProviderChallenge,
			task: { type: "TurnstileTaskProxyless", websiteURL: RECAPTCHA_CHALLENGE.pageUrl, websiteKey: "ts-key", action: "managed", data: "data" },
		},
		{
			challenge: { kind: "recaptcha_v3", siteKey: "v3-key", pageUrl: RECAPTCHA_CHALLENGE.pageUrl, action: "login", minScore: 0.7 } satisfies ProviderChallenge,
			task: { type: "RecaptchaV3TaskProxyless", websiteURL: RECAPTCHA_CHALLENGE.pageUrl, websiteKey: "v3-key", minScore: 0.7, pageAction: "login" },
		},
		{
			challenge: { kind: "hcaptcha", siteKey: "h-key", pageUrl: RECAPTCHA_CHALLENGE.pageUrl } satisfies ProviderChallenge,
			task: { type: "HCaptchaTaskProxyless", websiteURL: RECAPTCHA_CHALLENGE.pageUrl, websiteKey: "h-key" },
		},
	])("creates and maps $challenge.kind", async ({ challenge, task }) => {
		const stub = successfulFetch({ token: `${challenge.kind}-token` });
		await expect(createAdapter(stub).solve(challenge, undefined, new AbortController().signal)).resolves.toEqual({ form: "token", token: `${challenge.kind}-token` });
		expect(stub.calls[0]?.body.task).toEqual(task);
	});

	it("rejects reCAPTCHA v3 without the upstream-required minScore", async () => {
		const stub = createFetchStub([]);
		const error = await capturedError(
			createAdapter(stub).solve(
				{
					kind: "recaptcha_v3",
					siteKey: "key",
					pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
					action: "login",
				},
				undefined,
				new AbortController().signal,
			),
		);
		expect(error).toMatchObject({
			vendor: "2captcha",
			reason: "missing_challenge_input",
			missingFields: ["minScore"],
			phase: "create_task",
		});
		expect((error as Error).message).toContain("minScore");
		expect(stub.calls).toHaveLength(0);
	});

	it("creates proxied Turnstile and hCaptcha tasks", async () => {
		for (const challenge of [
			{ kind: "turnstile", siteKey: "ts-key", pageUrl: RECAPTCHA_CHALLENGE.pageUrl } satisfies ProviderChallenge,
			{ kind: "hcaptcha", siteKey: "h-key", pageUrl: RECAPTCHA_CHALLENGE.pageUrl } satisfies ProviderChallenge,
		]) {
			const stub = successfulFetch({ token: "proxied-token" });
			await createAdapter(stub).solve(challenge, { proxyUrl: "socks5://u:p@proxy.example:1080", userAgent: "UA" }, new AbortController().signal);
			expect(stub.calls[0]?.body.task).toMatchObject({ type: challenge.kind === "turnstile" ? "TurnstileTask" : "HCaptchaTask", proxyType: "socks5", proxyAddress: "proxy.example", proxyPort: 1080, proxyLogin: "u", proxyPassword: "p", userAgent: "UA" });
		}
	});

	it("creates a proxyless AWS WAF task from gokuProps and returns existing_token", async () => {
		const stub = successfulFetch({ existing_token: "aws-waf-token-value" });
		const adapter = createAdapter(stub);

		const result = await adapter.solve(AWS_WAF_CHALLENGE, undefined, new AbortController().signal);

		expect(result).toEqual({ form: "token", token: "aws-waf-token-value" });
		expect(stub.calls.map((call) => call.url)).toEqual([
			"https://solver.test/api/createTask",
			"https://solver.test/api/getTaskResult",
		]);
		expect(stub.calls[0]?.body).toEqual({
			clientKey: "test-api-key",
			task: {
				type: "AmazonTaskProxyless",
				websiteURL: AWS_WAF_CHALLENGE.pageUrl,
				websiteKey: AWS_WAF_CHALLENGE.siteKey,
				captchaScript: AWS_WAF_CHALLENGE.captchaScript,
				context: AWS_WAF_CHALLENGE.context,
				iv: AWS_WAF_CHALLENGE.iv,
			},
		});
		expect(stub.calls[1]?.body).toEqual({ clientKey: "test-api-key", taskId: 42 });
	});

	it("creates a proxied AmazonTask from the supplied resolver identity", async () => {
		const stub = successfulFetch({ existing_token: "proxied-aws-waf-token" });
		const adapter = createAdapter(stub);

		await adapter.solve(
			AWS_WAF_CHALLENGE,
			{
				proxyUrl: "socks5://proxy-user:proxy-password@proxy.example:1080",
				userAgent: "Measured Browser/1.0",
			},
			new AbortController().signal,
		);

		expect(stub.calls[0]?.body).toMatchObject({
			task: {
				type: "AmazonTask",
				websiteURL: AWS_WAF_CHALLENGE.pageUrl,
				websiteKey: AWS_WAF_CHALLENGE.siteKey,
				captchaScript: AWS_WAF_CHALLENGE.captchaScript,
				context: AWS_WAF_CHALLENGE.context,
				iv: AWS_WAF_CHALLENGE.iv,
				proxyType: "socks5",
				proxyAddress: "proxy.example",
				proxyPort: 1080,
				proxyLogin: "proxy-user",
				proxyPassword: "proxy-password",
				userAgent: "Measured Browser/1.0",
			},
		});
	});

	it("reaches AmazonTask through an SDK-resolved proxy lease", async () => {
		const originalUsername = process.env[NODEMAVEN_USERNAME_ENV];
		const originalPassword = process.env[NODEMAVEN_PASSWORD_ENV];
		process.env[NODEMAVEN_USERNAME_ENV] = "twocaptcha-runtime-account";
		process.env[NODEMAVEN_PASSWORD_ENV] = "twocaptcha-runtime-password";
		try {
			const stub = successfulFetch({ existing_token: "runtime-proxied-aws-waf-token" });
			const resolver = createResolverClient({
				adapters: [createAdapter(stub)],
				kinds: ["aws_waf"],
				proxyIntent: {
					mode: "required",
					upstream: {
						proxy: { mode: "required", providers: ["nodemaven"] },
					},
					userAgent: "Measured Browser/1.0",
				},
			});

			await expect(resolver.solve(AWS_WAF_CHALLENGE)).resolves.toEqual({
				form: "token",
				token: "runtime-proxied-aws-waf-token",
			});
			expect(stub.calls[0]?.body).toMatchObject({
				task: {
					type: "AmazonTask",
					proxyType: "http",
					proxyAddress: "gate.nodemaven.com",
					proxyLogin: expect.stringContaining("twocaptcha-runtime-account"),
					proxyPassword: "twocaptcha-runtime-password",
					userAgent: "Measured Browser/1.0",
				},
			});
		} finally {
			if (originalUsername === undefined) delete process.env[NODEMAVEN_USERNAME_ENV];
			else process.env[NODEMAVEN_USERNAME_ENV] = originalUsername;
			if (originalPassword === undefined) delete process.env[NODEMAVEN_PASSWORD_ENV];
			else process.env[NODEMAVEN_PASSWORD_ENV] = originalPassword;
		}
	});

	it.each([
		{ cookie: "wrong-cookie-field" },
		{ token: "wrong-token-field" },
	])("rejects an AWS WAF result without existing_token: %o", async (solution) => {
		await expect(
			createAdapter(successfulFetch(solution)).solve(
				AWS_WAF_CHALLENGE,
				undefined,
				new AbortController().signal,
			),
		).rejects.toMatchObject({
			vendor: "2captcha",
			reason: "transport_failure",
			phase: "poll_result",
		});
	});

	it.each([
		{ ...AWS_WAF_CHALLENGE, siteKey: undefined },
		{ ...AWS_WAF_CHALLENGE, captchaScript: undefined },
		{ ...AWS_WAF_CHALLENGE, context: undefined },
		{ ...AWS_WAF_CHALLENGE, iv: undefined },
	])("rejects AWS WAF without every required page artifact: %o", async (challenge) => {
		const stub = createFetchStub([]);
		const apiKey = "input-gap-api-key-secret";
		const proxyUrl = "http://input-gap-user:input-gap-password@proxy.example:8080";
		const error = await capturedError(
			createAdapter(stub, { apiKey }).solve(
				challenge,
				{ proxyUrl, userAgent: "InputGapBrowser/1.0" },
				new AbortController().signal,
			),
		);
		const missingField =
			challenge.siteKey === undefined
				? "siteKey"
				: challenge.captchaScript === undefined
					? "captchaScript"
					: challenge.context === undefined
						? "context"
						: "iv";

		expect(error).toMatchObject({
			vendor: "2captcha",
			reason: "missing_challenge_input",
			missingFields: [missingField],
			phase: "create_task",
		});
		expect((error as Error).message).toContain(missingField);
		const serialized = JSON.stringify(error);
		for (const secret of [
			apiKey,
			proxyUrl,
			AWS_WAF_CHALLENGE.siteKey,
			AWS_WAF_CHALLENGE.captchaScript,
			AWS_WAF_CHALLENGE.context,
			AWS_WAF_CHALLENGE.iv,
		]) {
			expect((error as Error).message).not.toContain(secret);
			expect(serialized).not.toContain(secret);
		}
		expect(stub.calls).toHaveLength(0);
	});

	it("falls through incomplete AWS WAF input to a vendor with a different input contract", async () => {
		const stub = createFetchStub([]);
		const chain = createTwoVendorChain(createAdapter(stub));
		const challenge = {
			kind: "aws_waf",
			pageUrl: AWS_WAF_CHALLENGE.pageUrl,
		} satisfies ProviderChallenge;

		await expect(chain.client.solve(challenge)).resolves.toEqual({
			form: "token",
			token: "second-vendor-token",
		});
		expect(stub.calls).toHaveLength(0);
		expect(chain.secondCalls()).toBe(1);
	});

	it("surfaces missing challenge fields in exhausted chain details", async () => {
		const stub = createFetchStub([]);
		const chain = createTwoVendorChain(createAdapter(stub), async () => {
			throw new ResolverVendorUnavailableError("custom", "not_implemented");
		});
		const challenge = {
			kind: "aws_waf",
			pageUrl: AWS_WAF_CHALLENGE.pageUrl,
		} satisfies ProviderChallenge;

		await expect(chain.client.solve(challenge)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			message: expect.stringContaining(
				"missing fields: siteKey, captchaScript, context, iv",
			),
			fix: "Capture the named challenge fields or configure another supporting resolver vendor.",
			details: [
				{
					vendor: "2captcha",
					reason: "missing_challenge_input",
					missingFields: ["siteKey", "captchaScript", "context", "iv"],
					phase: "create_task",
				},
				{ vendor: "custom", reason: "not_implemented" },
			],
		});
		expect(stub.calls).toHaveLength(0);
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

	it.each(UNSUPPORTED_CHALLENGES)("rejects unsupported $kind without attempting a request", async (challenge) => {
		const stub = createFetchStub([]);
		const error = await capturedError(
			createAdapter(stub).solve(challenge, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(TypeError);
		expect(stub.calls).toHaveLength(0);
	});

	it("reads support for every kind from the declared capability table", () => {
		const adapter = createAdapter(createFetchStub([]));
		const declared = RESOLVER_VENDOR_CAPABILITIES["2captcha"] as readonly ProviderChallengeKind[];

		expect(
			Object.fromEntries(declared.map((kind) => [kind, adapter.supports(kind)])),
		).toEqual(Object.fromEntries(declared.map((kind) => [kind, true])));
	});

	it("agrees with every declared capability without a not_implemented result", async () => {
		const declared = RESOLVER_VENDOR_CAPABILITIES["2captcha"] as readonly ProviderChallengeKind[];
		for (const kind of declared) {
			const challenge = kind === "aws_waf" ? AWS_WAF_CHALLENGE : kind === "recaptcha_v3" ? { kind, siteKey: "key", pageUrl: RECAPTCHA_CHALLENGE.pageUrl, action: "action", minScore: 0.3 } : { kind, siteKey: "key", pageUrl: RECAPTCHA_CHALLENGE.pageUrl };
			const stub = successfulFetch(kind === "aws_waf" ? { existing_token: "token" } : { token: "token" });
			await expect(createAdapter(stub).solve(challenge, undefined, new AbortController().signal)).resolves.toBeDefined();
		}
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

	it("attributes a polling timeout on the poll span", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-1" }),
			jsonResponse({ errorId: 0, status: "processing" }),
		]);
		let now = 0;
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");

		const error = await capturedError(
			createAdapter(stub, {
				delay: async (ms) => {
					now += ms;
				},
				now: () => now,
				pollIntervalMs: 3,
				timeoutMs: 5,
			}).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal, recorder),
		);

		expect(error).toMatchObject({ vendor: "2captcha", reason: "timeout" });

		const spans = trace.getSpans();
		expect(spans).toHaveLength(2);
		expect(spans[0]).toMatchObject({ name: "resolver.vendor.create_task", status: "ok" });
		expect(spans[1]).toEqual(
			expect.objectContaining({
				name: "resolver.vendor.poll_result",
				attributes: expect.objectContaining({
					unavailability_reason: "timeout",
					transport_phase: "poll_result",
				}),
			}),
		);
	});

	it("classifies ERROR_CAPTCHA_UNSOLVABLE as a failed solve verdict", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: 42 }),
			jsonResponse({
				errorId: 12,
				errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
				errorDescription: "Workers could not solve the Captcha",
			}),
		]);

		const error = await capturedError(
			createAdapter(stub).solve(AWS_WAF_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverChallengeVerdictError);
		expect(error).not.toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({ vendor: "2captcha", reason: "solve_failed" });
		expect((error as Error).message).toBe(
			"Resolver vendor 2captcha attempted the challenge but did not solve it",
		);
	});

	it("does not advance the chain after ERROR_CAPTCHA_UNSOLVABLE", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: 42 }),
			jsonResponse({
				errorId: 12,
				errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
				errorDescription: "Workers could not solve the Captcha",
			}),
		]);
		const chain = createTwoVendorChain(createAdapter(stub));

		await expect(chain.client.solve(AWS_WAF_CHALLENGE)).rejects.toMatchObject({
			name: "ResolverChallengeVerdictError",
			reason: "solve_failed",
		});
		expect(chain.secondCalls()).toBe(0);
	});

	it("advances the chain after a non-JSON transport failure", async () => {
		const stub = createFetchStub([new Response("upstream failure", { status: 502 })]);
		const chain = createTwoVendorChain(createAdapter(stub), async () => {
			throw new ResolverVendorUnavailableError("custom", "not_implemented");
		});

		await expect(chain.client.solve(AWS_WAF_CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [
				{ vendor: "2captcha", reason: "transport_failure", phase: "create_task" },
				{ vendor: "custom", reason: "not_implemented" },
			],
		});
		expect(chain.secondCalls()).toBe(1);
	});

	it("advances the chain after ERROR_ZERO_BALANCE", async () => {
		const stub = createFetchStub([
			jsonResponse({
				errorId: 10,
				errorCode: "ERROR_ZERO_BALANCE",
				errorDescription: "Account has zero funds",
			}),
		]);
		const chain = createTwoVendorChain(createAdapter(stub), async () => {
			throw new ResolverVendorUnavailableError("custom", "not_implemented");
		});

		await expect(chain.client.solve(AWS_WAF_CHALLENGE)).rejects.toMatchObject({
			code: "RESOLVER_CHAIN_EXHAUSTED",
			details: [
				{ vendor: "2captcha", reason: "allocation_exhausted", phase: "create_task" },
				{ vendor: "custom", reason: "not_implemented" },
			],
		});
		expect(chain.secondCalls()).toBe(1);
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

	it("maps AWS WAF vendor errors without exposing the API key", async () => {
		const apiKey = "aws-waf-api-key-secret";
		const stub = createFetchStub([
			jsonResponse({
				errorId: 1,
				errorCode: "ERROR_TASK_ABSENT",
				errorDescription: `rejected ${apiKey}`,
			}),
		]);

		const error = await capturedError(
			createAdapter(stub, { apiKey }).solve(
				AWS_WAF_CHALLENGE,
				undefined,
				new AbortController().signal,
			),
		);

		expect(error).toMatchObject({
			vendor: "2captcha",
			reason: "transport_failure",
			phase: "create_task",
		});
		expect((error as Error).message).not.toContain(apiKey);
		expect(String((error as Error).cause ?? "")).not.toContain(apiKey);
	});

	it("maps AWS WAF polling allocation errors without exposing the API key", async () => {
		const apiKey = "aws-waf-poll-api-key-secret";
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: 42 }),
			jsonResponse({
				errorId: 10,
				errorCode: "ERROR_ZERO_BALANCE",
				errorDescription: `zero balance for ${apiKey}`,
			}),
		]);

		const error = await capturedError(
			createAdapter(stub, { apiKey }).solve(
				AWS_WAF_CHALLENGE,
				undefined,
				new AbortController().signal,
			),
		);

		expect(error).toMatchObject({
			vendor: "2captcha",
			reason: "allocation_exhausted",
			phase: "poll_result",
		});
		expect((error as Error).message).not.toContain(apiKey);
		expect(String((error as Error).cause ?? "")).not.toContain(apiKey);
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

	it("does not retain a create-task network cause containing the API key", async () => {
		const apiKey = "network-error-api-key-secret";
		const stub = createFetchStub([new Error(`request failed for ${apiKey}`)]);
		const error = await capturedError(
			createAdapter(stub, { apiKey }).solve(
				AWS_WAF_CHALLENGE,
				undefined,
				new AbortController().signal,
			),
		);

		expect(error).toMatchObject({
			vendor: "2captcha",
			reason: "transport_failure",
			phase: "create_task",
		});
		expect((error as Error).message).not.toContain(apiKey);
		expect((error as Error).cause).toBeUndefined();
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
