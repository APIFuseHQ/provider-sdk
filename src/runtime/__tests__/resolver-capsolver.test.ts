import { describe, expect, it } from "bun:test";

import { assertIsError, capturedError } from "../../__tests__/test-utils.js";
import { ProviderError } from "../../errors.js";
import { getStealthProfile } from "../../stealth/profiles.js";
import type { ProviderChallenge } from "../../types.js";
import { createProviderCache } from "../cache.js";
import {
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	createResolverClient,
	createResolverClientFromEnv,
	swapResolverAdapterFactoryForTests,
} from "../resolver.js";
import { createCapsolverResolverVendorAdapter } from "../resolver-vendors/capsolver.js";
import {
	ResolverChallengeVerdictError,
	type ResolverVendorAdapter,
	ResolverVendorUnavailableError,
} from "../resolver-vendors/types.js";
import { RESOLVER_VENDOR_CAPABILITIES } from "../resolver-vendors/types.js";
import { DEFAULT_STEALTH_PROFILE } from "../stealth.js";
import { createTraceContext, getTraceRecorder } from "../trace.js";

const TURNSTILE_CHALLENGE = {
	kind: "turnstile",
	siteKey: "turnstile-site-key",
	pageUrl: "https://example.com/protected",
} satisfies ProviderChallenge;

const RECAPTCHA_CHALLENGE = {
	kind: "recaptcha_v2",
	siteKey: "recaptcha-site-key",
	pageUrl: TURNSTILE_CHALLENGE.pageUrl,
} satisfies ProviderChallenge;

const AWS_WAF_CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://example.com/protected",
	siteKey: "aws-key",
	iv: "aws-iv",
	context: "aws-context",
	captchaScript: "https://captcha.awswaf.com/challenge.js",
} satisfies ProviderChallenge;

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
	overrides: Partial<Parameters<typeof createCapsolverResolverVendorAdapter>[0]> = {},
) {
	return createCapsolverResolverVendorAdapter({
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

function collectNestedStrings(value: unknown, seen = new Set<object>()): string[] {
	if (typeof value === "string") return [value];
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function") ||
		seen.has(value)
	) {
		return [];
	}
	seen.add(value);

	const strings: string[] = [];
	for (const property of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, property);
		if (descriptor && "value" in descriptor) {
			strings.push(...collectNestedStrings(descriptor.value, seen));
		}
	}
	return strings;
}

describe("Capsolver resolver vendor", () => {
	it("routes AWS WAF through the capability table, creates a proxyless task, and maps its cookie", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "aws-task-proxyless" }),
			jsonResponse({ errorId: 0, status: "processing" }),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { cookie: "aws-cookie-value" },
			}),
		]);
		const resolver = createResolverClient({ adapters: [createAdapter(stub)], kinds: ["aws_waf"] });

		await expect(resolver.solve(AWS_WAF_CHALLENGE)).resolves.toEqual({
			form: "cookies",
			cookies: { "aws-waf-token": "aws-cookie-value" },
			userAgent: getStealthProfile(DEFAULT_STEALTH_PROFILE).userAgent,
			sdkEstimatedExpires: expect.any(Number),
		});
		expect(stub.calls[0]?.body).toEqual({
			clientKey: "test-api-key",
			task: {
				type: "AntiAwsWafTaskProxyLess",
				websiteURL: AWS_WAF_CHALLENGE.pageUrl,
				awsKey: AWS_WAF_CHALLENGE.siteKey,
				awsIv: AWS_WAF_CHALLENGE.iv,
				awsContext: AWS_WAF_CHALLENGE.context,
				awsChallengeJS: AWS_WAF_CHALLENGE.captchaScript,
			},
		});
		expect(stub.calls.slice(1).map((call) => call.body)).toEqual([
			{ clientKey: "test-api-key", taskId: "aws-task-proxyless" },
			{ clientKey: "test-api-key", taskId: "aws-task-proxyless" },
		]);
	});

	it.each([
		{
			label: "HTTP with its default port",
			proxyUrl: "http://proxy-user:proxy-password@proxy.example",
		},
		{
			label: "SOCKS5 with its default port and URL-encoded credentials",
			proxyUrl: "socks5://proxy%40user:p%40ssword@proxy.example",
		},
	])("creates a proxyless AWS WAF task with a $label identity", async ({ proxyUrl }) => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "aws-task-proxied" }),
			jsonResponse({ errorId: 0, status: "ready", solution: { cookie: "proxied-cookie" } }),
		]);
		const identity = { proxyUrl, userAgent: "resolver-identity-user-agent" };

		await expect(
			createAdapter(stub).solve(AWS_WAF_CHALLENGE, identity, new AbortController().signal),
		).resolves.toEqual({
			form: "cookies",
			cookies: { "aws-waf-token": "proxied-cookie" },
			userAgent: identity.userAgent,
			sdkEstimatedExpires: expect.any(Number),
		});
		expect(stub.calls[0]?.body).toEqual({
			clientKey: "test-api-key",
			task: {
				type: "AntiAwsWafTaskProxyLess",
				websiteURL: AWS_WAF_CHALLENGE.pageUrl,
				awsKey: AWS_WAF_CHALLENGE.siteKey,
				awsIv: AWS_WAF_CHALLENGE.iv,
				awsContext: AWS_WAF_CHALLENGE.context,
				awsChallengeJS: AWS_WAF_CHALLENGE.captchaScript,
				userAgent: identity.userAgent,
			},
		});
		expect(stub.calls[0]?.body.task).not.toHaveProperty("proxy");
	});

	it("caches a CapSolver AWS WAF cookie by its SDK-estimated expiry", async () => {
		const beforeMs = Date.now();
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "cached-aws-task" }),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { cookie: "cached-aws-cookie" },
			}),
		]);
		const capsolver = createAdapter(stub);
		let adapterCalls = 0;
		const countingAdapter: ResolverVendorAdapter = {
			...capsolver,
			async solve(challenge, identity, signal, traceRecorder) {
				adapterCalls += 1;
				return await capsolver.solve(challenge, identity, signal, traceRecorder);
			},
		};
		const cache = createProviderCache({
			providerId: "resolver-capsolver-estimated-expiry",
			redisUrl: "",
		});
		const resolver = createResolverClient({
			adapters: [countingAdapter],
			cache,
			kinds: ["aws_waf"],
		});
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");

		const first = await resolver.solve(AWS_WAF_CHALLENGE, undefined, recorder);
		const afterMs = Date.now();
		const second = await resolver.solve(AWS_WAF_CHALLENGE, undefined, recorder);

		expect(first).toMatchObject({
			form: "cookies",
			cookies: { "aws-waf-token": "cached-aws-cookie" },
			userAgent: getStealthProfile(DEFAULT_STEALTH_PROFILE).userAgent,
		});
		if (first.form !== "cookies" || !("cookies" in first)) {
			throw new Error("expected cookies solution");
		}
		expect(first.sdkEstimatedExpires).toBeGreaterThanOrEqual((beforeMs + 60 * 60 * 1_000) / 1_000);
		expect(first.sdkEstimatedExpires).toBeLessThanOrEqual((afterMs + 60 * 60 * 1_000) / 1_000);
		expect(first).not.toHaveProperty("expires");
		expect(second).toEqual(first);
		expect(adapterCalls).toBe(1);
		expect(stub.calls).toHaveLength(2);
		expect(trace.getSpans().filter((span) => span.name === "resolver.usage")).toHaveLength(1);
	});

	it("classifies an AWS WAF allocation error during task creation", async () => {
		const stub = createFetchStub([
			jsonResponse({
				errorId: 1,
				errorCode: "ERROR_ZERO_BALANCE",
				errorDescription: "Account has zero funds",
			}),
		]);

		const error = await capturedError(
			createAdapter(stub).solve(AWS_WAF_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "allocation_exhausted",
			phase: "create_task",
		});
	});

	it("classifies an elapsed AWS WAF polling budget as a timeout", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "aws-timeout-task" }),
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
			}).solve(AWS_WAF_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "timeout",
			phase: "poll_result",
		});
		expect(stub.calls).toHaveLength(2);
	});

	it("redacts AWS WAF API and proxy credentials from thrown diagnostics", async () => {
		const apiKey = "aws-capsolver-api-secret";
		const proxyUrl = "socks5://aws-proxy-user:aws-proxy-password@proxy.example:1443";
		const convertedProxy = "socks5:proxy.example:1443:aws-proxy-user:aws-proxy-password";
		const stub = createFetchStub([
			jsonResponse({
				errorId: 1,
				errorCode: `ERROR_${apiKey}`,
				errorDescription: `Rejected ${convertedProxy}`,
			}),
		]);

		const error = await capturedError(
			createAdapter(stub, { apiKey }).solve(
				AWS_WAF_CHALLENGE,
				{ proxyUrl, userAgent: "resolver-identity-user-agent" },
				new AbortController().signal,
			),
		);

		expect(error).toMatchObject({
			errorCode: "ERROR_[REDACTED]",
			errorDescription: "Rejected [REDACTED]",
		});
		const serialized = [error.message, JSON.stringify(error), ...collectNestedStrings(error)].join(
			"\n",
		);
		for (const secret of [
			apiKey,
			proxyUrl,
			convertedProxy,
			"aws-proxy-user",
			"aws-proxy-password",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("creates a proxyless Turnstile task without metadata when challenge metadata is absent", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-42" }),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { token: "turnstile-token" },
			}),
		]);

		await expect(
			createAdapter(stub).solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		).resolves.toEqual({ form: "token", token: "turnstile-token" });

		expect(stub.calls.map((call) => call.url)).toEqual([
			"https://solver.test/api/createTask",
			"https://solver.test/api/getTaskResult",
		]);
		expect(stub.calls[0]?.body).toEqual({
			clientKey: "test-api-key",
			task: {
				type: "AntiTurnstileTaskProxyLess",
				websiteURL: TURNSTILE_CHALLENGE.pageUrl,
				websiteKey: TURNSTILE_CHALLENGE.siteKey,
			},
		});
		expect(stub.calls[1]?.body).toEqual({ clientKey: "test-api-key", taskId: "task-42" });
		expect((stub.calls[0]?.body.task as Record<string, unknown>).metadata).toBeUndefined();
	});

	it("forwards Turnstile action and cdata in createTask metadata", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-with-metadata" }),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { token: "metadata-token" },
			}),
		]);
		const challenge = {
			...TURNSTILE_CHALLENGE,
			action: "login",
			cdata: "turnstile-custom-data",
		} satisfies ProviderChallenge;

		await expect(
			createAdapter(stub).solve(challenge, undefined, new AbortController().signal),
		).resolves.toEqual({ form: "token", token: "metadata-token" });

		expect(stub.calls[0]?.body).toEqual({
			clientKey: "test-api-key",
			task: {
				type: "AntiTurnstileTaskProxyLess",
				websiteURL: challenge.pageUrl,
				websiteKey: challenge.siteKey,
				metadata: { action: "login", cdata: "turnstile-custom-data" },
			},
		});
	});

	it("maps a non-zero createTask errorId to create_task and preserves vendor detail", async () => {
		const stub = createFetchStub([
			jsonResponse({
				errorId: 1,
				errorCode: "ERROR_TASK_CREATE_FAILED",
				errorDescription: "Task creation was rejected",
				taskId: "must-not-be-polled",
			}),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { token: "must-not-return" },
			}),
		]);

		const error = await capturedError(
			createAdapter(stub).solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "transport_failure",
			phase: "create_task",
			errorCode: "ERROR_TASK_CREATE_FAILED",
			errorDescription: "Task creation was rejected",
		});
		expect(stub.calls).toHaveLength(1);
	});

	it("maps a non-zero getTaskResult errorId to poll_result and preserves vendor detail", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-42" }),
			jsonResponse({
				errorId: 1,
				errorCode: "ERROR_TASK_RESULT_FAILED",
				errorDescription: "Task result was rejected",
				status: "ready",
				solution: { token: "must-not-return" },
			}),
		]);

		const error = await capturedError(
			createAdapter(stub).solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "transport_failure",
			phase: "poll_result",
			errorCode: "ERROR_TASK_RESULT_FAILED",
			errorDescription: "Task result was rejected",
		});
	});

	it("preserves unsolvable vendor detail on the failed-solve verdict", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-42" }),
			jsonResponse({
				errorId: 12,
				errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
				errorDescription: "Workers could not solve the captcha",
			}),
		]);
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");

		const error = await capturedError(
			createAdapter(stub).solve(
				TURNSTILE_CHALLENGE,
				undefined,
				new AbortController().signal,
				recorder,
			),
		);

		expect(error).toBeInstanceOf(ResolverChallengeVerdictError);
		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "solve_failed",
			phase: "poll_result",
			errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
			errorDescription: "Workers could not solve the captcha",
		});
		expect(trace.getSpans()[2]?.attributes).toMatchObject({
			verdict_reason: "solve_failed",
			transport_phase: "poll_result",
			vendor_error_code: "ERROR_CAPTCHA_UNSOLVABLE",
			vendor_error_description: "Workers could not solve the captcha",
		});
	});

	it("preserves zero-balance detail on an allocation-exhausted failure", async () => {
		const stub = createFetchStub([
			jsonResponse({
				errorId: 10,
				errorCode: "ERROR_ZERO_BALANCE",
				errorDescription: "Account has zero funds",
			}),
		]);

		const error = await capturedError(
			createAdapter(stub).solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "allocation_exhausted",
			phase: "create_task",
			errorCode: "ERROR_ZERO_BALANCE",
			errorDescription: "Account has zero funds",
		});
	});

	it("redacts the API key from vendor error fields and trace attributes", async () => {
		const apiKey = "capsolver-vendor-detail-secret";
		const stub = createFetchStub([
			jsonResponse({
				errorId: 1,
				errorCode: `ERROR_TASK_${apiKey}`,
				errorDescription: `Capsolver rejected ${apiKey}`,
			}),
		]);
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");

		const error = await capturedError(
			createAdapter(stub, { apiKey }).solve(
				TURNSTILE_CHALLENGE,
				undefined,
				new AbortController().signal,
				recorder,
			),
		);

		expect(error).toMatchObject({
			errorCode: "ERROR_TASK_[REDACTED]",
			errorDescription: "Capsolver rejected [REDACTED]",
		});
		expect(trace.getSpans()[0]?.attributes).toMatchObject({
			vendor_error_code: "ERROR_TASK_[REDACTED]",
			vendor_error_description: "Capsolver rejected [REDACTED]",
		});
		expect(trace.getSpans().find((span) => span.name === "resolver.usage")).toMatchObject({
			status: "error",
			attributes: expect.objectContaining({ outcome: "vendor_error", billable_units: 1 }),
		});
		expect(JSON.stringify({ error, spans: trace.getSpans() })).not.toContain(apiKey);
	});

	it("redacts echoed challenge values from public errors and trace attributes", async () => {
		const challenge = {
			kind: "turnstile",
			pageUrl: "https://example.com/protected?session=page-url-secret",
			siteKey: "echoed-site-key-secret",
			action: "echoed-action-secret",
			cdata: "echoed-cdata-secret",
		} satisfies ProviderChallenge;
		const sensitiveValues = [
			challenge.pageUrl,
			challenge.siteKey,
			challenge.action,
			challenge.cdata,
		];
		const stub = createFetchStub([
			jsonResponse({
				errorId: 1,
				errorCode: "ERROR_TASK_CREATE_FAILED",
				errorDescription: `Capsolver rejected websiteURL=${challenge.pageUrl}, websiteKey=${challenge.siteKey}, action=${challenge.action}, cdata=${challenge.cdata}`,
			}),
		]);
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");
		const resolver = createResolverClient({
			adapters: [createAdapter(stub)],
			kinds: ["turnstile"],
		});

		const publicError = await capturedError(
			resolver.solve(challenge, new AbortController().signal, recorder),
		);

		expect(publicError).toBeInstanceOf(ProviderError);
		expect((publicError as ProviderError).code).toBe("RESOLVER_CHAIN_EXHAUSTED");
		const createTaskSpan = trace
			.getSpans()
			.find((span) => span.name === "resolver.vendor.create_task");
		expect(createTaskSpan?.attributes).toMatchObject({
			vendor_error_description:
				"Capsolver rejected websiteURL=[REDACTED], websiteKey=[REDACTED], action=[REDACTED], cdata=[REDACTED]",
		});
		const exposedDiagnostics = collectNestedStrings({
			publicError,
			traceAttributes: trace.getSpans().map((span) => span.attributes),
		}).join("\n");
		for (const sensitiveValue of sensitiveValues) {
			expect(exposedDiagnostics).not.toContain(sensitiveValue);
		}
	});

	it("retains a sanitized JSON parse cause without exposing response secrets in public diagnostics", async () => {
		const apiKey = "capsolver-public-diagnostic-secret";
		const responseText = `<html>${apiKey}: super-secret-upstream-body</html>`;
		const stub = createFetchStub([
			new Response(responseText, {
				status: 502,
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
			new Response(responseText, {
				status: 502,
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		]);
		const adapter = createAdapter(stub, { apiKey });

		const error = await capturedError(
			adapter.solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "transport_failure",
			phase: "create_task",
			responseStatus: 502,
			responseContentType: "text/html; charset=utf-8",
			responseLength: responseText.length,
		});
		const parseCause = error.cause;
		expect(parseCause).toBeInstanceOf(SyntaxError);
		assertIsError(parseCause);
		expect(parseCause.message.startsWith("Upstream response failed")).toBe(true);

		const resolver = createResolverClient({ adapters: [adapter], kinds: ["turnstile"] });
		const publicError = await capturedError(resolver.solve(TURNSTILE_CHALLENGE));
		expect(publicError).toBeInstanceOf(ProviderError);
		expect((publicError as ProviderError).code).toBe("RESOLVER_CHAIN_EXHAUSTED");
		const [attempt] = (publicError as ProviderError).details as Array<{
			vendor: string;
			reason: string;
			cause?: { name: string; message: string };
		}>;
		expect(attempt).toMatchObject({
			vendor: "capsolver",
			reason: "transport_failure",
			cause: { name: "SyntaxError" },
		});
		expect(attempt?.cause?.message.startsWith("Upstream response failed")).toBe(true);

		const exposedStrings = collectNestedStrings({ error, publicError });
		const publicDiagnostics = exposedStrings.join("\n");
		expect(publicDiagnostics).not.toContain(responseText);
		expect(publicDiagnostics).not.toContain(apiKey);
		expect(publicDiagnostics).not.toContain("super-secret-upstream-body");
	});

	it("accepts unknown fields while narrowing createTask and getTaskResult responses", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-42", vendorExtension: { ignored: true } }),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { token: "turnstile-token", extraSolutionField: 42 },
				anotherVendorExtension: ["ignored"],
			}),
		]);

		await expect(
			createAdapter(stub).solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		).resolves.toEqual({ form: "token", token: "turnstile-token" });
	});

	it("polls again after an idle result and resolves when the task becomes ready", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-42" }),
			jsonResponse({ errorId: 0, status: "idle" }),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { token: "turnstile-token" },
			}),
		]);

		await expect(
			createAdapter(stub).solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		).resolves.toEqual({ form: "token", token: "turnstile-token" });
		expect(stub.calls.map((call) => call.url)).toEqual([
			"https://solver.test/api/createTask",
			"https://solver.test/api/getTaskResult",
			"https://solver.test/api/getTaskResult",
		]);
	});

	it("rejects a ready result without solution.token", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-42" }),
			jsonResponse({ errorId: 0, status: "ready", solution: {} }),
		]);

		const error = await capturedError(
			createAdapter(stub).solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "transport_failure",
			phase: "poll_result",
		});
	});

	it("rejects a token-bearing getTaskResult response whose status is not ready", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-42" }),
			jsonResponse({
				errorId: 0,
				status: "queued",
				solution: { token: "premature-token" },
			}),
		]);

		const error = await capturedError(
			createAdapter(stub).solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "transport_failure",
			phase: "poll_result",
		});
		expect(stub.calls).toHaveLength(2);
	});

	it("maps an elapsed polling ceiling to timeout without sleeping", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task-42" }),
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
			}).solve(TURNSTILE_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({ vendor: "capsolver", reason: "timeout", phase: "poll_result" });
		expect(stub.calls).toHaveLength(2);
	});

	it("stops promptly with the caller abort reason during the polling delay", async () => {
		const stub = createFetchStub([jsonResponse({ errorId: 0, taskId: "task-42" })]);
		const controller = new AbortController();
		const abort = new DOMException("caller stopped", "AbortError");
		let markDelayStarted: (() => void) | undefined;
		const delayStarted = new Promise<void>((resolve) => {
			markDelayStarted = resolve;
		});
		const adapter = createAdapter(stub, {
			delay: async (_ms, signal) =>
				await new Promise<void>((_resolve, reject) => {
					markDelayStarted?.();
					if (signal.aborted) {
						reject(signal.reason);
						return;
					}
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
			timeoutMs: 10_000,
		});
		const solve = adapter.solve(TURNSTILE_CHALLENGE, undefined, controller.signal);
		await delayStarted;

		const startedAt = Date.now();
		controller.abort(abort);

		await expect(solve).rejects.toBe(abort);
		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(stub.calls).toHaveLength(1);
	});

	it.each([
		undefined,
		" \t ",
	])("reports a missing or blank API key without attempting a request: %o", async (apiKey) => {
		const stub = createFetchStub([]);
		const trace = createTraceContext();
		const recorder = getTraceRecorder(trace);
		if (!recorder) throw new Error("Test trace context did not expose its recorder");
		const error = await capturedError(
			createAdapter(stub, { apiKey }).solve(
				TURNSTILE_CHALLENGE,
				undefined,
				new AbortController().signal,
				recorder,
			),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "missing_credentials",
			phase: "create_task",
		});
		expect(stub.calls).toHaveLength(0);
		expect(trace.getSpans().filter((span) => span.name === "resolver.usage")).toHaveLength(0);
	});

	it("rejects an undeclared challenge host before calling Capsolver", async () => {
		const stub = createFetchStub([]);
		const error = await capturedError(
			createAdapter(stub).solve(
				{ ...TURNSTILE_CHALLENGE, pageUrl: "https://undeclared.example/protected" },
				undefined,
				new AbortController().signal,
			),
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({ code: "RESOLVER_HOST_NOT_ALLOWED" });
		expect(stub.calls).toHaveLength(0);
	});

	it.each([
		{
			challenge: RECAPTCHA_CHALLENGE,
			task: {
				type: "ReCaptchaV2TaskProxyLess",
				websiteURL: RECAPTCHA_CHALLENGE.pageUrl,
				websiteKey: RECAPTCHA_CHALLENGE.siteKey,
			},
			solution: { token: "v2-token" },
		},
		{
			challenge: {
				kind: "recaptcha_v3",
				siteKey: "v3-key",
				pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
				action: "login",
				minScore: 0.7,
			} satisfies ProviderChallenge,
			task: {
				type: "ReCaptchaV3TaskProxyLess",
				websiteURL: RECAPTCHA_CHALLENGE.pageUrl,
				websiteKey: "v3-key",
				pageAction: "login",
				minScore: 0.7,
			},
			solution: { gRecaptchaResponse: "v3-token" },
		},
		{
			challenge: {
				kind: "hcaptcha",
				siteKey: "h-key",
				pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
			} satisfies ProviderChallenge,
			task: {
				type: "HCaptchaTaskProxyLess",
				websiteURL: RECAPTCHA_CHALLENGE.pageUrl,
				websiteKey: "h-key",
			},
			solution: { token: "h-token" },
		},
	])("creates and maps $challenge.kind", async ({ challenge, task, solution }) => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "task" }),
			jsonResponse({ errorId: 0, status: "ready", solution }),
		]);
		await expect(
			createAdapter(stub).solve(challenge, undefined, new AbortController().signal),
		).resolves.toEqual({
			form: "token",
			token: Object.values(solution)[0],
		});
		expect(stub.calls[0]?.body.task as Record<string, unknown>).toEqual(task);
	});

	it("uses CapSolver proxy task variants for reCAPTCHA and hCaptcha", async () => {
		const cases = [
			{ challenge: RECAPTCHA_CHALLENGE, type: "ReCaptchaV2Task" },
			{
				challenge: {
					kind: "recaptcha_v3",
					siteKey: "v3",
					pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
					action: "a",
				} satisfies ProviderChallenge,
				type: "ReCaptchaV3Task",
			},
			{
				challenge: {
					kind: "hcaptcha",
					siteKey: "h",
					pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
				} satisfies ProviderChallenge,
				type: "HCaptchaTask",
			},
		] as const;
		for (const { challenge, type } of cases) {
			const stub = createFetchStub([
				jsonResponse({ errorId: 0, taskId: "task" }),
				jsonResponse({ errorId: 0, status: "ready", solution: { token: "token" } }),
			]);
			await createAdapter(stub).solve(
				challenge,
				{ proxyUrl: "http://u:p@proxy.example:8080", userAgent: "UA" },
				new AbortController().signal,
			);
			expect(stub.calls[0]?.body.task).toMatchObject({
				type,
				proxy: "http:proxy.example:8080:u:p",
			});
		}
	});

	it("creates AntiCloudflareTask with required proxy and maps clearance cookies", async () => {
		const stub = createFetchStub([
			jsonResponse({ errorId: 0, taskId: "cf-task" }),
			jsonResponse({
				errorId: 0,
				status: "ready",
				solution: { cookies: { cf_clearance: "clearance" }, userAgent: "solver-ua" },
			}),
		]);
		const challenge = {
			kind: "cloudflare_interstitial",
			pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
			blockedHtml: "<html>blocked</html>",
		} satisfies ProviderChallenge;
		await expect(
			createAdapter(stub).solve(
				challenge,
				{ proxyUrl: "http://u:p@proxy.example:8080", userAgent: "client-ua" },
				new AbortController().signal,
			),
		).resolves.toEqual({
			form: "cookies",
			cookies: { cf_clearance: "clearance" },
			userAgent: "solver-ua",
		});
		expect(stub.calls[0]?.body.task).toEqual({
			type: "AntiCloudflareTask",
			websiteURL: challenge.pageUrl,
			proxy: "http:proxy.example:8080:u:p",
			userAgent: "client-ua",
			html: challenge.blockedHtml,
		});
	});

	it("rejects Cloudflare interstitial without a proxy identity", async () => {
		const stub = createFetchStub([]);
		await expect(
			createAdapter(stub).solve(
				{ kind: "cloudflare_interstitial", pageUrl: RECAPTCHA_CHALLENGE.pageUrl },
				undefined,
				new AbortController().signal,
			),
		).rejects.toMatchObject({
			vendor: "capsolver",
			reason: "missing_proxy_identity",
			phase: "create_task",
		});
		expect(stub.calls).toHaveLength(0);
	});

	it("agrees with every declared capability without a not_implemented result", async () => {
		for (const kind of RESOLVER_VENDOR_CAPABILITIES.capsolver) {
			const challenge =
				kind === "cloudflare_interstitial"
					? ({ kind, pageUrl: RECAPTCHA_CHALLENGE.pageUrl } satisfies ProviderChallenge)
					: kind === "recaptcha_v3"
						? ({
								kind,
								siteKey: "key",
								pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
								action: "action",
							} satisfies ProviderChallenge)
						: kind === "aws_waf"
							? AWS_WAF_CHALLENGE
							: ({
									kind,
									siteKey: "key",
									pageUrl: RECAPTCHA_CHALLENGE.pageUrl,
								} satisfies ProviderChallenge);
			const stub = createFetchStub([
				jsonResponse({ errorId: 0, taskId: "agreement" }),
				jsonResponse({
					errorId: 0,
					status: "ready",
					solution:
						kind === "aws_waf"
							? { cookie: "cookie" }
							: kind === "cloudflare_interstitial"
								? { cookies: { cf_clearance: "cookie" } }
								: { token: "token" },
				}),
			]);
			const identity =
				kind === "cloudflare_interstitial"
					? { proxyUrl: "http://u:p@proxy.example:8080", userAgent: "ua" }
					: undefined;
			await expect(
				createAdapter(stub).solve(challenge, identity, new AbortController().signal),
			).resolves.toBeDefined();
		}
	});

	it("reaches the registered Capsolver adapter when its env key is configured", async () => {
		let solveCalls = 0;
		let factoryConfiguration: string | undefined;
		const adapter: ResolverVendorAdapter = {
			id: "capsolver",
			supports: (kind) => kind === "turnstile",
			async solve(challenge) {
				solveCalls += 1;
				expect(challenge).toEqual(TURNSTILE_CHALLENGE);
				return { form: "token", token: "registry-token" };
			},
		};
		const restoreAdapter = swapResolverAdapterFactoryForTests(
			"capsolver",
			(configuration, _timeoutMs, allowedHosts) => {
				factoryConfiguration = configuration;
				expect(allowedHosts).toEqual(["example.com"]);
				return adapter;
			},
		);

		try {
			const resolver = createResolverClientFromEnv(
				{ vendors: ["capsolver"], kinds: ["turnstile"] },
				{ [APIFUSE__RESOLVER__CAPSOLVER__API_KEY]: "configured-capsolver-key" },
				{ allowedHosts: ["example.com"] },
			);

			await expect(resolver.solve(TURNSTILE_CHALLENGE)).resolves.toEqual({
				form: "token",
				token: "registry-token",
			});
			expect(factoryConfiguration).toBe("configured-capsolver-key");
			expect(solveCalls).toBe(1);
		} finally {
			restoreAdapter();
		}
	});
});
