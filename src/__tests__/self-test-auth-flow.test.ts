import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { ProviderError } from "../errors";
import { createMemoryProviderRuntimeState } from "../runtime/state";
import {
	createSelfTestApp,
	createSelfTestAuthFlowInvoke,
	createSelfTestInvoke,
	SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON,
	SELF_TEST_PATH,
	type SelfTestResponse,
} from "../server/self-test";
import { deriveSelfTestToken } from "../server/self-test-token";
import { createServerApp } from "../server/serve";
import type { AuthTurn, ProviderDefinition } from "../types";

const MASTER_SECRET = "self-test-master-secret";
const PROVIDER_ID = "flow-provider";
const CREDENTIAL_INPUTS = { phone: "010-1234-5678", password: "pw-secret-1234" };

interface FlowProviderState {
	loginCount: number;
	/** Every `flow.start()` invocation, regardless of outcome. */
	startCount: number;
	/** Every `flow.continue()` invocation, regardless of outcome. */
	continueCount: number;
	/** Cookie the upstream currently accepts; probes with any other value 401. */
	validCookie: string;
	/** Cookie the next successful login will issue. */
	nextCookie: () => string;
	/** When true, `continue` never completes (OTP-style second turn). */
	multiTurn: boolean;
	/** When true, `continue` throws (transient upstream/transport failure). */
	flowError: boolean;
	/** When true, `start` returns a terminal abort turn. */
	abortAtStart: boolean;
	/** When true, `continue` returns a terminal abort turn. */
	abortAtContinue: boolean;
	/** When true, `continue` returns a turn kind unknown to TURN_KINDS. */
	unknownTurnAtContinue: boolean;
	/** Artificial latency inside `flow.start()` (deadline tests). */
	startDelayMs: number;
	/** Artificial latency inside the probe handler (deadline tests). */
	probeDelayMs: number;
	/** Optional per-case timeout override applied to the session case. */
	caseTimeoutMs?: number;
}

function createFlowProviderState(): FlowProviderState {
	let issued = 0;
	return {
		loginCount: 0,
		startCount: 0,
		continueCount: 0,
		validCookie: "flow-session-secret-v1",
		nextCookie: () => `flow-session-secret-v${++issued}`,
		multiTurn: false,
		flowError: false,
		abortAtStart: false,
		abortAtContinue: false,
		unknownTurnAtContinue: false,
		startDelayMs: 0,
		probeDelayMs: 0,
	};
}

function createFlowProvider(state: FlowProviderState): ProviderDefinition {
	const formTurn = (turnId: string): AuthTurn => ({
		kind: "form",
		turnId,
		expectedInput: {
			schema: {
				type: "object",
				required: ["phone", "password"],
				properties: { phone: { type: "string" }, password: { type: "string" } },
			},
		},
	});

	return {
		id: PROVIDER_ID,
		version: "1.0.0",
		runtime: "standard",
		meta: { displayName: "Flow Provider", category: "test" },
		credential: { keys: ["sessionCookie", "userId"] },
		healthProbe: {
			credentialInputs: {
				phone: "FLOW_PROVIDER_FAKE_PHONE_ENV",
				password: "FLOW_PROVIDER_FAKE_PASSWORD_ENV",
			},
			requiredSecrets: ["FLOW_PROVIDER_FAKE_PHONE_ENV", "FLOW_PROVIDER_FAKE_PASSWORD_ENV"],
		},
		auth: {
			mode: "credentials",
			flow: {
				start: async () => {
					state.startCount += 1;
					if (state.startDelayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, state.startDelayMs));
					}
					if (state.abortAtStart) {
						return { kind: "abort", turnId: "turn-abort-start" } as AuthTurn;
					}
					return formTurn("turn-start");
				},
				continue: async (_ctx, input = {}) => {
					state.continueCount += 1;
					if (state.flowError) {
						throw new Error("upstream login endpoint temporarily unreachable");
					}
					if (state.abortAtContinue) {
						return { kind: "abort", turnId: "turn-abort-continue" } as AuthTurn;
					}
					if (state.unknownTurnAtContinue) {
						return { kind: "mystery_kind", turnId: "turn-mystery" } as unknown as AuthTurn;
					}
					if (state.multiTurn) {
						return formTurn("turn-otp");
					}
					if (
						input.phone !== CREDENTIAL_INPUTS.phone ||
						input.password !== CREDENTIAL_INPUTS.password
					) {
						return formTurn("turn-retry");
					}
					state.loginCount += 1;
					return {
						kind: "complete",
						turnId: `turn-complete-${state.loginCount}`,
						data: {
							credential: {
								sessionCookie: state.nextCookie(),
								userId: "user-1",
							},
						},
					};
				},
			},
		},
		operations: {
			session: {
				annotations: { readOnly: true },
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async (ctx: {
					credential: { get(key: string): string | undefined; getAll(): Record<string, string> };
				}) => {
					if (state.probeDelayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, state.probeDelayMs));
					}
					const cookie = ctx.credential.get("sessionCookie");
					if (cookie !== state.validCookie) {
						throw new ProviderError("upstream rejected stale session", {
							code: "AUTH_REQUIRED",
						});
					}
					const secretKeys = Object.keys(ctx.credential.getAll()).sort();
					return {
						ok:
							ctx.credential.get("userId") === "user-1" &&
							secretKeys.join(",") === "sessionCookie,userId",
					};
				},
				healthCheck: {
					interval: "5m",
					requiresConnection: true,
					cases: [
						{
							name: "session case",
							input: {},
							...(state.caseTimeoutMs !== undefined ? { timeoutMs: state.caseTimeoutMs } : {}),
							assertions: ({ data }: { data: unknown }) => {
								if (!(data as { ok: boolean }).ok) {
									throw new Error("flow credential did not reach handler");
								}
							},
						},
					],
				},
			},
			leaky: {
				annotations: { readOnly: true },
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async (ctx: { credential: { get(key: string): string | undefined } }) => {
					throw new ProviderError(
						`upstream exploded with session ${ctx.credential.get("sessionCookie")}`,
						{ code: "UPSTREAM_ERROR" },
					);
				},
				healthCheck: {
					interval: "5m",
					requiresConnection: true,
					cases: [{ name: "leaky case", input: {}, assertions: () => {} }],
				},
			},
		},
	} as unknown as ProviderDefinition;
}

function createFlowlessProvider(): ProviderDefinition {
	return {
		id: PROVIDER_ID,
		version: "1.0.0",
		runtime: "standard",
		meta: { displayName: "Flowless Provider", category: "test" },
		credential: { keys: ["phone", "password"] },
		healthProbe: {
			credentialInputs: {
				phone: "FLOW_PROVIDER_FAKE_PHONE_ENV",
				password: "FLOW_PROVIDER_FAKE_PASSWORD_ENV",
			},
			requiredSecrets: ["FLOW_PROVIDER_FAKE_PHONE_ENV", "FLOW_PROVIDER_FAKE_PASSWORD_ENV"],
		},
		// credentials mode WITHOUT a flow: raw-input semantics must be preserved.
		auth: { mode: "credentials" },
		operations: {
			raw: {
				annotations: { readOnly: true },
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async (ctx: { credential: { get(key: string): string | undefined } }) => ({
					ok: ctx.credential.get("phone") === CREDENTIAL_INPUTS.phone,
				}),
				healthCheck: {
					interval: "5m",
					requiresConnection: true,
					cases: [
						{
							name: "raw case",
							input: {},
							assertions: ({ data }: { data: unknown }) => {
								if (!(data as { ok: boolean }).ok) {
									throw new Error("raw credential inputs did not reach handler");
								}
							},
						},
					],
				},
			},
		},
	} as unknown as ProviderDefinition;
}

function createApps(provider: ProviderDefinition, options: { withAuthFlow?: boolean } = {}) {
	const tenantApp = createServerApp(provider, {
		logger: () => {},
		state: createMemoryProviderRuntimeState(),
	});
	const selfTestApp = createSelfTestApp(provider, {
		secrets: { current: MASTER_SECRET },
		invoke: createSelfTestInvoke(tenantApp),
		...(options.withAuthFlow === false
			? {}
			: { authFlow: createSelfTestAuthFlowInvoke(tenantApp) }),
	});
	return { tenantApp, selfTestApp };
}

const validToken = deriveSelfTestToken(MASTER_SECRET, PROVIDER_ID);

async function runCase(
	selfTestApp: { request: (path: string, init?: RequestInit) => Promise<Response> },
	operationId: string,
	caseName: string,
	requestId = "req-flow-test",
	inputs: Record<string, string> = CREDENTIAL_INPUTS,
): Promise<SelfTestResponse> {
	const response = await selfTestApp.request(SELF_TEST_PATH, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${validToken}`,
		},
		body: JSON.stringify({
			schemaVersion: 1,
			requestId,
			operationId,
			caseName,
			credentials: { inputs },
		}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as SelfTestResponse;
}

describe("self-test auth-flow connection semantics (DR-7)", () => {
	it("materializes the connection from the flow's completed credential (production shape)", async () => {
		const state = createFlowProviderState();
		const { selfTestApp } = createApps(createFlowProvider(state));

		const body = await runCase(selfTestApp, "session", "session case");
		expect(body.result?.status).toBe("ok");
		// The handler only passes when connection.secrets are exactly the
		// flow-materialized credential (sessionCookie + userId), not the raw
		// phone/password inputs.
		expect(state.loginCount).toBe(1);
	});

	it("reports multi-turn flows as skipped with the exact auth_flow_multi_turn reason", async () => {
		const state = createFlowProviderState();
		state.multiTurn = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const body = await runCase(selfTestApp, "session", "session case");
		expect(body.result?.status).toBe("skipped");
		expect(body.result?.skipReason).toBe("auth_flow_multi_turn");
		expect(body.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON);
		expect(state.loginCount).toBe(0);
	});

	it("memoizes the multi-turn outcome: later cycles skip WITHOUT contacting the upstream flow", async () => {
		const state = createFlowProviderState();
		state.multiTurn = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON);
		expect(state.startCount).toBe(1);
		expect(state.continueCount).toBe(1);

		// Second probe cycle: same skip, ZERO additional flow traffic — the
		// first continue already submitted real credentials upstream (OTP
		// send / lockout risk), so the outcome must be served from the
		// session cache (DR-7: probes must not log in every cycle).
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.status).toBe("skipped");
		expect(second.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON);
		expect(state.startCount).toBe(1);
		expect(state.continueCount).toBe(1);
	});

	it("re-attempts the flow when credentialInputs change (different cache key)", async () => {
		const state = createFlowProviderState();
		state.multiTurn = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(state.continueCount).toBe(1);

		// Rotated credentials hash to a different cache key: the memoized
		// multi-turn entry for the old inputs must not suppress a genuine
		// re-attempt with the new ones.
		const rotated = await runCase(selfTestApp, "session", "session case", "req-cycle-2", {
			phone: CREDENTIAL_INPUTS.phone,
			password: "rotated-password-5678",
		});
		expect(rotated.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON);
		expect(state.startCount).toBe(2);
		expect(state.continueCount).toBe(2);
	});

	it("never memoizes flow ERRORS: each cycle may retry a transient failure", async () => {
		const state = createFlowProviderState();
		state.flowError = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("error");
		expect(first.result?.error?.code).toBe("auth_flow_failed");
		expect(state.continueCount).toBe(1);

		// A thrown/errored flow is transient by policy — the next cycle
		// retries instead of being frozen by a negative cache entry…
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.status).toBe("error");
		expect(state.continueCount).toBe(2);

		// …so recovery is observed as soon as the upstream comes back.
		state.flowError = false;
		const third = await runCase(selfTestApp, "session", "session case", "req-cycle-3");
		expect(third.result?.status).toBe("ok");
		expect(state.loginCount).toBe(1);
		expect(state.continueCount).toBe(3);
	});

	it("reuses the cached session across probe cycles instead of logging in every cycle", async () => {
		const state = createFlowProviderState();
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(first.result?.status).toBe("ok");
		expect(second.result?.status).toBe("ok");
		expect(state.loginCount).toBe(1);
	});

	it("re-runs the flow exactly once when a cached session fails the probe with an auth error", async () => {
		const state = createFlowProviderState();
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("ok");
		expect(state.loginCount).toBe(1);

		// Upstream rotates the session: the cached cookie (v1) is now stale and
		// the next login will issue v2, which the upstream accepts.
		state.validCookie = "flow-session-secret-v2";
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.status).toBe("ok");
		expect(state.loginCount).toBe(2);

		// Upstream now rejects everything, including fresh logins (v3): the
		// executor must re-login at most ONCE and then report the failure.
		state.validCookie = "never-issued";
		const third = await runCase(selfTestApp, "session", "session case", "req-cycle-3");
		expect(third.result?.status).toBe("failed");
		expect(third.result?.httpStatus).toBe(401);
		expect(state.loginCount).toBe(3);
	});

	it("stops after a terminal abort turn from start — credentials are never submitted", async () => {
		const state = createFlowProviderState();
		state.abortAtStart = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("error");
		expect(first.result?.error?.code).toBe("auth_flow_aborted");
		expect(state.continueCount).toBe(0);

		// Aborts are transient by policy (e.g. upstream maintenance) — never
		// memoized, so the next cycle re-attempts the flow.
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.error?.code).toBe("auth_flow_aborted");
		expect(state.startCount).toBe(2);
		expect(state.continueCount).toBe(0);
	});

	it("treats an abort after credential submission as a flow error, not a multi-turn skip", async () => {
		const state = createFlowProviderState();
		state.abortAtContinue = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("error");
		expect(first.result?.error?.code).toBe("auth_flow_aborted");
		expect(first.result?.skipReason).toBeUndefined();

		// NOT negative-cached as multi_turn: the next cycle re-drives the flow.
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.error?.code).toBe("auth_flow_aborted");
		expect(state.startCount).toBe(2);
		expect(state.continueCount).toBe(2);
	});

	it("treats an unknown turn kind as a flow error, never a memoized multi-turn skip", async () => {
		const state = createFlowProviderState();
		state.unknownTurnAtContinue = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("error");
		expect(first.result?.error?.code).toBe("auth_flow_unexpected_turn");
		expect(first.result?.skipReason).toBeUndefined();

		// Ambiguous turns may encode a transient provider failure — the next
		// cycle re-drives the flow instead of being frozen by a negative entry.
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.error?.code).toBe("auth_flow_unexpected_turn");
		expect(state.startCount).toBe(2);
		expect(state.continueCount).toBe(2);
	});

	it("enforces ONE deadline across flow materialization and the probe", async () => {
		const state = createFlowProviderState();
		// Each stage alone fits the 450ms budget; together they cannot. The old
		// per-stage timers would pass this case in ~600ms — the shared deadline
		// must fail it with a timeout.
		state.startDelayMs = 300;
		state.probeDelayMs = 300;
		state.caseTimeoutMs = 450;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const body = await runCase(selfTestApp, "session", "session case");
		expect(body.result?.status).toBe("error");
		expect(body.result?.error?.code).toBe("self_test_timeout");
	});

	it("redacts flow-materialized secrets from every probe output", async () => {
		const state = createFlowProviderState();
		const { selfTestApp } = createApps(createFlowProvider(state));

		const response = await selfTestApp.request(SELF_TEST_PATH, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${validToken}`,
			},
			body: JSON.stringify({
				schemaVersion: 1,
				requestId: "req-leak",
				operationId: "leaky",
				caseName: "leaky case",
				credentials: { inputs: CREDENTIAL_INPUTS },
			}),
		});
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(state.loginCount).toBe(1);
		// The flow issued flow-session-secret-v1 and the handler echoed it into
		// the error message; it must never leave the pod.
		expect(text).not.toContain("flow-session-secret-v1");
		expect(text).toContain("[REDACTED]");
		const body = JSON.parse(text) as SelfTestResponse;
		expect(body.result?.status).toBe("failed");
	});

	it("keeps raw-input semantics for credentials providers without a declared flow", async () => {
		const { selfTestApp } = createApps(createFlowlessProvider());
		const body = await runCase(selfTestApp, "raw", "raw case");
		expect(body.result?.status).toBe("ok");
	});

	it("reports a visible auth_flow_unavailable error when the host has no auth-flow driver", async () => {
		const state = createFlowProviderState();
		const { selfTestApp } = createApps(createFlowProvider(state), { withAuthFlow: false });

		const body = await runCase(selfTestApp, "session", "session case");
		expect(body.result?.status).toBe("error");
		expect(body.result?.error?.code).toBe("auth_flow_unavailable");
		expect(state.loginCount).toBe(0);
	});
});
