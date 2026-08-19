import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../errors.js";
import type { ProviderChallenge } from "../../types.js";
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

async function capturedError(operation: Promise<unknown>): Promise<unknown> {
	return await operation.catch((error: unknown) => error);
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
		expect(trace.getSpans()[1]?.attributes).toMatchObject({
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
		const parseCause = (error as Error).cause;
		expect(parseCause).toBeInstanceOf(SyntaxError);
		expect((parseCause as Error).message.startsWith("Upstream response failed")).toBe(true);

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
		const error = await capturedError(
			createAdapter(stub, { apiKey }).solve(
				TURNSTILE_CHALLENGE,
				undefined,
				new AbortController().signal,
			),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "missing_credentials",
			phase: "create_task",
		});
		expect(stub.calls).toHaveLength(0);
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

	it("reports a declared non-Turnstile kind as not implemented", async () => {
		const stub = createFetchStub([]);
		const error = await capturedError(
			createAdapter(stub).solve(RECAPTCHA_CHALLENGE, undefined, new AbortController().signal),
		);

		expect(error).toBeInstanceOf(ResolverVendorUnavailableError);
		expect(error).toMatchObject({
			vendor: "capsolver",
			reason: "not_implemented",
			phase: "create_task",
		});
		expect(stub.calls).toHaveLength(0);
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
