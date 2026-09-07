import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import { ProviderError } from "../errors.js";
import { createMemoryProviderRuntimeState } from "../runtime/state.js";
import {
	computeSelfTestPlanDigest,
	createSelfTestApp,
	createSelfTestInvoke,
	SELF_TEST_HEALTHZ_PATH,
	SELF_TEST_PATH,
	type SelfTestResponse,
} from "../server/self-test.js";
import {
	deriveSelfTestToken,
	PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_ENV,
	resolveSelfTestMasterSecrets,
} from "../server/self-test-token.js";
import { createServerApp } from "./helpers/server.js";
import type { ProviderDefinition } from "../types.js";
import { createProviderDefinitionDouble } from "./test-utils.js";

const MASTER_SECRET = "self-test-master-secret";
const PREVIOUS_MASTER_SECRET = "self-test-previous-master-secret";
const UPSTREAM_SECRET_ENV = "SELF_TEST_FAKE_UPSTREAM_KEY";
const UPSTREAM_SECRET_VALUE = "sk-super-secret-upstream-value-1234";

beforeAll(() => {
	process.env[UPSTREAM_SECRET_ENV] = UPSTREAM_SECRET_VALUE;
});

afterAll(() => {
	delete process.env[UPSTREAM_SECRET_ENV];
});

function createProvider(overrides: { caseName?: string } = {}): ProviderDefinition {
	return createProviderDefinitionDouble({
		id: "self-test-provider",
		version: "1.0.0",
		runtime: "standard",
		http: true,
		secrets: [{ name: UPSTREAM_SECRET_ENV, issuer: "contributor" }],
		credential: { keys: ["phone"] },
		meta: {
			displayName: "Self Test Provider",
			descriptionKey: "self-test-provider.description",
			category: "test",
		},
		healthProbe: {
			credentialInputs: { phone: "SELF_TEST_FAKE_PHONE_ENV" },
			requiredSecrets: ["SELF_TEST_FAKE_PHONE_ENV"],
		},
		operations: {
			echo: {
				riskClass: "read",
				input: z.object({ value: z.string() }),
				output: z.object({ echoed: z.string() }),
				handler: async (_ctx, input) => ({
					echoed: (input as { value: string }).value,
				}),
				healthCheck: {
					interval: "5m",
					timeoutMs: 5_000,
					cases: [
						{
							name: overrides.caseName ?? "pass case",
							input: { value: "ok" },
							assertions: ({ data, status }) => {
								if (status !== 200) throw new Error(`status ${status}`);
								if ((data as { echoed: string }).echoed !== "ok") {
									throw new Error("echo mismatch");
								}
							},
						},
						{
							name: "fail case",
							description: "always fails",
							input: { value: "boom" },
							assertions: () => {
								throw new Error("assertion exploded");
							},
						},
						{
							name: "gated case",
							input: { value: "ok" },
							enabled: () => false,
							assertions: () => {},
						},
					],
				},
			},
			leak: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					throw new ProviderError(
						`upstream rejected credential ${process.env[UPSTREAM_SECRET_ENV]}`,
						{ code: "UPSTREAM_ERROR" },
					);
				},
				healthCheck: {
					interval: "5m",
					cases: [{ name: "leaky case", input: {}, assertions: () => {} }],
				},
			},
			slow: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => {
					await new Promise((resolve) => setTimeout(resolve, 250));
					return { ok: true };
				},
				healthCheck: {
					interval: "5m",
					cases: [
						{ name: "slow case", input: {}, timeoutMs: 25, assertions: () => {} },
						{ name: "slow ok case", input: {}, assertions: () => {} },
					],
				},
			},
			mutate: {
				riskClass: "write",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async () => ({ ok: true }),
				healthCheck: {
					interval: "5m",
					cases: [{ name: "mutating case", input: {}, assertions: () => {} }],
				},
			},
			connected: {
				riskClass: "read",
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async (ctx) => ({
					ok: ctx.credential.get("phone") === "010-1234-5678",
				}),
				healthCheck: {
					interval: "5m",
					requiresConnection: true,
					cases: [
						{
							name: "connected case",
							input: {},
							assertions: ({ data }) => {
								if (!(data as { ok: boolean }).ok) {
									throw new Error("credential did not reach handler");
								}
							},
						},
					],
				},
			},
		},
	});
}

function createApps(
	provider: ProviderDefinition = createProvider(),
	secretsArg: { current: string; previous?: string } | "off" = {
		current: MASTER_SECRET,
	},
) {
	const secrets = secretsArg === "off" ? undefined : secretsArg;
	const tenantApp = createServerApp(provider, {
		logger: () => {},
		state: createMemoryProviderRuntimeState(),
	});
	const selfTestApp = createSelfTestApp(provider, {
		secrets,
		invoke: createSelfTestInvoke(tenantApp),
	});
	return { tenantApp, selfTestApp, provider };
}

const validToken = deriveSelfTestToken(MASTER_SECRET, "self-test-provider");

function postSelfTest(
	app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
	body: Record<string, unknown>,
	token: string | "no-token" = validToken,
	path: string = SELF_TEST_PATH,
): Promise<Response> {
	return Promise.resolve(
		app.request(path, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token === "no-token" ? {} : { authorization: `Bearer ${token}` }),
			},
			body: JSON.stringify({
				schemaVersion: 1,
				requestId: "req-test",
				...body,
			}),
		}),
	);
}

describe("self-test internal listener", () => {
	it("serves unauthenticated /healthz liveness returning {ok:true} only", async () => {
		const { selfTestApp } = createApps();
		const response = await selfTestApp.request(SELF_TEST_HEALTHZ_PATH);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("is off without the master secret env (no secrets => 404, env resolution undefined)", async () => {
		expect(
			resolveSelfTestMasterSecrets({
				SOME_OTHER_ENV: "x",
				[PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_ENV]: undefined,
			}),
		).toBeUndefined();
		expect(
			resolveSelfTestMasterSecrets({
				[PROVIDER_RUNTIME_SELF_TEST_MASTER_SECRET_ENV]: "   ",
			}),
		).toBeUndefined();

		const { selfTestApp } = createApps(createProvider(), "off");
		const response = await postSelfTest(selfTestApp, {
			operations: ["echo"],
		});
		expect(response.status).toBe(404);
	});

	it("rejects a missing token with 401 and no detail", async () => {
		const { selfTestApp } = createApps();
		const response = await postSelfTest(selfTestApp, { operations: ["echo"] }, "no-token");
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: { code: "unauthorized", message: "Unauthorized" },
		});
	});

	it("rejects a wrong token with 401 (constant-time verification path)", async () => {
		const { selfTestApp } = createApps();
		const wrongToken = deriveSelfTestToken("some-other-master", "self-test-provider");
		const response = await postSelfTest(selfTestApp, { operations: ["echo"] }, wrongToken);
		expect(response.status).toBe(401);
		const shortToken = await postSelfTest(selfTestApp, { operations: ["echo"] }, "nope");
		expect(shortToken.status).toBe(401);
	});

	it("accepts the current-derived token and the previous-derived token (rotation window)", async () => {
		const { selfTestApp } = createApps(createProvider(), {
			current: MASTER_SECRET,
			previous: PREVIOUS_MASTER_SECRET,
		});
		const current = await postSelfTest(selfTestApp, {
			operationId: "echo",
			caseName: "pass case",
		});
		expect(current.status).toBe(200);
		const previousToken = deriveSelfTestToken(PREVIOUS_MASTER_SECRET, "self-test-provider");
		const previous = await postSelfTest(
			selfTestApp,
			{ operationId: "echo", caseName: "pass case" },
			previousToken,
		);
		expect(previous.status).toBe(200);
	});

	it("executes healthCheck cases in-process: pass, fail, and disabled-skip results", async () => {
		const { selfTestApp } = createApps();
		const response = await postSelfTest(selfTestApp, { operations: ["echo"] });
		expect(response.status).toBe(200);
		const body = (await response.json()) as SelfTestResponse;
		expect(body.schemaVersion).toBe(1);
		expect(body.providerId).toBe("self-test-provider");
		expect(typeof body.sdkVersion).toBe("string");
		expect(body.planDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(body.results).toHaveLength(3);

		const pass = body.results.find((entry) => entry.caseName === "pass case");
		expect(pass?.status).toBe("ok");
		expect(pass?.assertion).toEqual({ passed: true });
		expect(pass?.httpStatus).toBe(200);
		expect(pass?.responseTimeMs).toBeGreaterThanOrEqual(0);
		expect(pass?.operationId).toBe("echo");

		const fail = body.results.find((entry) => entry.caseName === "fail case");
		expect(fail?.status).toBe("failed");
		expect(fail?.assertion?.passed).toBe(false);
		expect(fail?.assertion?.message).toContain("assertion exploded");
		expect(fail?.label).toBe("always fails");

		const gated = body.results.find((entry) => entry.caseName === "gated case");
		expect(gated?.status).toBe("skipped");
		expect(gated?.skipReason).toBe("disabled");
	});

	it("supports the single-case form and mirrors result into results[0]", async () => {
		const { selfTestApp } = createApps();
		const response = await postSelfTest(selfTestApp, {
			operationId: "echo",
			caseName: "pass case",
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as SelfTestResponse;
		expect(body.result?.status).toBe("ok");
		expect(body.results).toHaveLength(1);
		expect(body.result).toEqual(body.results[0]);
	});

	it("also serves the /self-test alias path", async () => {
		const { selfTestApp } = createApps();
		const response = await postSelfTest(
			selfTestApp,
			{ operationId: "echo", caseName: "pass case" },
			validToken,
			"/self-test",
		);
		expect(response.status).toBe(200);
	});

	it("refuses non-read operations with 403", async () => {
		const { selfTestApp } = createApps();
		const mutate = await postSelfTest(selfTestApp, {
			operationId: "mutate",
			caseName: "mutating case",
		});
		expect(mutate.status).toBe(403);
		const mutateBody = (await mutate.json()) as {
			error: { code: string };
		};
		expect(mutateBody.error.code).toBe("operation_not_read_only");
	});

	it("reports non-read-only cases as visible errors in batch mode", async () => {
		const { selfTestApp } = createApps();
		const response = await postSelfTest(selfTestApp, {
			operations: ["mutate"],
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as SelfTestResponse;
		expect(body.results[0]?.status).toBe("error");
		expect(body.results[0]?.error?.code).toBe("operation_not_read_only");
	});

	it("enforces per-case timeouts (fast) and reports self_test_timeout", async () => {
		const { selfTestApp } = createApps();
		const startedAt = performance.now();
		const response = await postSelfTest(selfTestApp, {
			operationId: "slow",
			caseName: "slow case",
		});
		const elapsed = performance.now() - startedAt;
		expect(response.status).toBe(200);
		const body = (await response.json()) as SelfTestResponse;
		expect(body.result?.status).toBe("error");
		expect(body.result?.error?.code).toBe("self_test_timeout");
		expect(elapsed).toBeLessThan(200);
	});

	it("aborts an in-flight ctx.http fetch when a self-test case times out", async () => {
		const provider = createProvider();
		provider.operations.abortableHttp = {
			riskClass: "read",
			input: z.object({}),
			output: z.object({ ok: z.boolean() }),
			handler: async (ctx) => {
				const response = await ctx.http.get("https://example.com/slow-self-test");
				return { ok: response.ok };
			},
			healthCheck: {
				interval: "5m",
				cases: [{ name: "abortable http case", input: {}, timeoutMs: 25, assertions: () => {} }],
			},
		};
		const originalFetch = globalThis.fetch;
		let observedSignal: AbortSignal | null | undefined;
		let resolveAbortObserved: ((aborted: boolean) => void) | undefined;
		const abortObserved = new Promise<boolean>((resolve) => {
			resolveAbortObserved = resolve;
		});
		globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
			observedSignal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				const onAbort = () => {
					resolveAbortObserved?.(observedSignal?.aborted === true);
					reject(observedSignal?.reason);
				};
				observedSignal?.addEventListener("abort", onAbort, { once: true });
				if (observedSignal?.aborted) onAbort();
			});
		}) as typeof fetch;

		try {
			const { selfTestApp } = createApps(provider);
			const response = await postSelfTest(selfTestApp, {
				operationId: "abortableHttp",
				caseName: "abortable http case",
			});
			const body = (await response.json()) as SelfTestResponse;

			expect(body.result?.error?.code).toBe("self_test_timeout");
			expect(await abortObserved).toBe(true);
			expect(observedSignal?.aborted).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("cancels a late operation response without starting body consumption", async () => {
		let resolveResponse: ((response: Response) => void) | undefined;
		const responsePromise = new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
		let sourceCancelCount = 0;
		let textCallCount = 0;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel() {
					sourceCancelCount += 1;
				},
			}),
		);
		Object.defineProperty(response, "text", {
			value: async () => {
				textCallCount += 1;
				return "never consumed";
			},
		});
		const invoke = createSelfTestInvoke({ request: () => responsePromise });
		const controller = new AbortController();
		const reason = new DOMException("case timed out", "AbortError");
		const pending = invoke({
			operationId: "echo",
			input: {},
			requestId: "req-late-response",
			signal: controller.signal,
		});

		controller.abort(reason);
		resolveResponse?.(response);

		await expect(pending).rejects.toBe(reason);
		expect(sourceCancelCount).toBe(1);
		expect(textCallCount).toBe(0);
	});

	it("settles promptly and redacts the cancellation event when the requester disconnects", async () => {
		const provider = createProvider();
		let markInvokeStarted: (() => void) | undefined;
		const invokeStarted = new Promise<void>((resolve) => {
			markInvokeStarted = resolve;
		});
		const events: unknown[] = [];
		let invokeCount = 0;
		const selfTestApp = createSelfTestApp(provider, {
			secrets: { current: MASTER_SECRET },
			invoke: () => {
				invokeCount += 1;
				markInvokeStarted?.();
				if (invokeCount === 1) return new Promise(() => {});
				return Promise.resolve({ status: 200, data: { echoed: "ok" } });
			},
			logger: (event) => events.push(event),
		});
		const controller = new AbortController();

		const responsePromise = selfTestApp.request(SELF_TEST_PATH, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${validToken}`,
			},
			body: JSON.stringify({
				schemaVersion: 1,
				requestId: "req-disconnected",
				operationId: "echo",
				caseName: "pass case",
				timeoutMs: 100,
			}),
			signal: controller.signal,
		});
		await invokeStarted;
		controller.abort(new Error(`requester disconnected: ${UPSTREAM_SECRET_VALUE}`));
		const response = await responsePromise;
		const body = (await response.json()) as SelfTestResponse;

		expect(response.status).toBe(200);
		expect(body.result?.error?.code).toBe("self_test_execution_error");
		const nextResponse = await postSelfTest(selfTestApp, {
			operationId: "echo",
			caseName: "pass case",
		});
		expect(nextResponse.status).toBe(200);
		expect(events).toEqual([
			{
				level: "info",
				event: "self_test_run_cancelled",
				providerId: "self-test-provider",
				requestId: "req-disconnected",
				operationId: "echo",
				caseName: "pass case",
				reason: "requester disconnected: [REDACTED]",
			},
		]);
		expect(JSON.stringify(events)).not.toContain(UPSTREAM_SECRET_VALUE);
	});

	it("honors the request-level timeoutMs override", async () => {
		const { selfTestApp } = createApps();
		const response = await postSelfTest(selfTestApp, {
			operationId: "slow",
			caseName: "slow ok case",
			timeoutMs: 20,
		});
		const body = (await response.json()) as SelfTestResponse;
		expect(body.result?.status).toBe("error");
		expect(body.result?.error?.code).toBe("self_test_timeout");
	});

	it("never echoes secret env values in results (redaction)", async () => {
		const { selfTestApp } = createApps();
		const response = await postSelfTest(selfTestApp, {
			operationId: "leak",
			caseName: "leaky case",
		});
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain(UPSTREAM_SECRET_VALUE);
		const body = JSON.parse(text) as SelfTestResponse;
		expect(body.result?.status).toBe("failed");
		expect(body.result?.error?.message).toContain("[REDACTED]");
	});

	it("skips requiresConnection cases without credentials and runs them with request-supplied inputs", async () => {
		const { selfTestApp } = createApps();
		const missing = await postSelfTest(selfTestApp, {
			operationId: "connected",
			caseName: "connected case",
		});
		const missingBody = (await missing.json()) as SelfTestResponse;
		expect(missingBody.result?.status).toBe("skipped");
		expect(missingBody.result?.skipReason).toBe("credential_missing:phone");

		const supplied = await postSelfTest(selfTestApp, {
			operationId: "connected",
			caseName: "connected case",
			credentials: { inputs: { phone: "010-1234-5678" } },
		});
		const suppliedBody = (await supplied.json()) as SelfTestResponse;
		expect(suppliedBody.result?.status).toBe("ok");
		// Request-supplied credential material must never be echoed.
		expect(JSON.stringify(suppliedBody)).not.toContain("010-1234-5678");
	});

	it("returns 422 case_not_found for unknown cases and unknown operations", async () => {
		const { selfTestApp } = createApps();
		const unknownCase = await postSelfTest(selfTestApp, {
			operationId: "echo",
			caseName: "renamed case",
		});
		expect(unknownCase.status).toBe(422);
		const unknownCaseBody = (await unknownCase.json()) as {
			error: { code: string };
		};
		expect(unknownCaseBody.error.code).toBe("case_not_found");

		const unknownOperation = await postSelfTest(selfTestApp, {
			operations: ["nope"],
		});
		expect(unknownOperation.status).toBe(422);
	});

	it("returns 400 unsupported_schema_version with the supported set", async () => {
		const { selfTestApp } = createApps();
		const response = await postSelfTest(selfTestApp, { schemaVersion: 2 });
		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			error: { code: string; supported: number[] };
		};
		expect(body.error.code).toBe("unsupported_schema_version");
		expect(body.error.supported).toEqual([1]);
	});

	it("rejects concurrent execution with 409 and retryAfterMs (parallelism 1)", async () => {
		const { selfTestApp } = createApps();
		const first = postSelfTest(selfTestApp, {
			operationId: "slow",
			caseName: "slow ok case",
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		const second = await postSelfTest(selfTestApp, {
			operationId: "echo",
			caseName: "pass case",
		});
		expect(second.status).toBe(409);
		const busyBody = (await second.json()) as {
			error: { code: string };
			retryAfterMs: number;
		};
		expect(busyBody.error.code).toBe("self_test_busy");
		expect(busyBody.retryAfterMs).toBeGreaterThan(0);
		expect((await first).status).toBe(200);
	});

	it("computes a stable planDigest that changes when the declared plan changes", () => {
		const digestA = computeSelfTestPlanDigest(createProvider());
		const digestB = computeSelfTestPlanDigest(createProvider());
		expect(digestA).toBe(digestB);
		const digestRenamed = computeSelfTestPlanDigest(
			createProvider({ caseName: "renamed pass case" }),
		);
		expect(digestRenamed).not.toBe(digestA);
	});
});
