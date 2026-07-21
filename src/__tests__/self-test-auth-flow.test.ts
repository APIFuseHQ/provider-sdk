import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { AuthError, ProviderError } from "../errors";
import { createMemoryProviderRuntimeState } from "../runtime/state";
import {
	createSelfTestApp,
	createSelfTestAuthFlowInvoke,
	createSelfTestInvoke,
	SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON,
	SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON,
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
	/** When true, `continue` throws an AuthError (defineCredentialsAuth-style rejection). */
	authErrorAtContinue: boolean;
	/** When true, `start` returns a terminal abort turn. */
	abortAtStart: boolean;
	/** When true, `start` returns a turn kind unknown to TURN_KINDS. */
	unknownTurnAtStart: boolean;
	/** When set, `start` returns this known NON-input turn kind (e.g. redirect). */
	nonInputTurnAtStart?: string;
	/** When true, `continue` returns a terminal abort turn. */
	abortAtContinue: boolean;
	/** When true, `continue` returns a turn kind unknown to TURN_KINDS. */
	unknownTurnAtContinue: boolean;
	/** Artificial latency inside `flow.start()` (deadline tests). */
	startDelayMs: number;
	/** Artificial latency inside `flow.continue()` (deadline tests). */
	continueDelayMs: number;
	/** Artificial latency inside the probe handler (deadline tests). */
	probeDelayMs: number;
	/** Connection ids observed by the session case's prepareInput, per run. */
	seenConnectionIds: string[];
	/** Helper statuses the prep case's prepareInput hook observed. */
	prepStatuses: number[];
	/** When true, the provider declares proxy.session.affinity = "operation". */
	operationAffinity: boolean;
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
		authErrorAtContinue: false,
		abortAtStart: false,
		unknownTurnAtStart: false,
		abortAtContinue: false,
		unknownTurnAtContinue: false,
		startDelayMs: 0,
		continueDelayMs: 0,
		probeDelayMs: 0,
		seenConnectionIds: [],
		prepStatuses: [],
		operationAffinity: false,
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
		...(state.operationAffinity ? { proxy: { session: { affinity: "operation" } } } : {}),
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
					if (state.unknownTurnAtStart) {
						return { kind: "mystery_kind", turnId: "turn-mystery-start" } as unknown as AuthTurn;
					}
					if (state.nonInputTurnAtStart !== undefined) {
						return {
							kind: state.nonInputTurnAtStart,
							turnId: "turn-noninput-start",
						} as unknown as AuthTurn;
					}
					return formTurn("turn-start");
				},
				continue: async (_ctx, input = {}) => {
					state.continueCount += 1;
					if (state.continueDelayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, state.continueDelayMs));
					}
					if (state.flowError) {
						throw new Error("upstream login endpoint temporarily unreachable");
					}
					if (state.authErrorAtContinue) {
						// defineCredentialsAuth-style rejection: login throws, the
						// /auth route answers 401 — no retry turn is ever produced.
						throw new AuthError("upstream rejected the password", {
							code: "AUTH_REQUIRED",
						});
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
						// Mirrors real providers (e.g. catchtable): invalid credentials
						// come back as a retry-kind turn, not a fresh form.
						return { kind: "retry", turnId: "turn-retry" } as unknown as AuthTurn;
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
							prepareInput: async ({
								input,
								connectionId,
							}: {
								input: unknown;
								connectionId?: string;
							}) => {
								state.seenConnectionIds.push(connectionId ?? "none");
								return input;
							},
							assertions: ({ data }: { data: unknown }) => {
								if (!(data as { ok: boolean }).ok) {
									throw new Error("flow credential did not reach handler");
								}
							},
						},
					],
				},
			},
			prep: {
				annotations: { readOnly: true },
				input: z.object({}),
				output: z.object({ ok: z.boolean() }),
				handler: async (ctx: {
					credential: { get(key: string): string | undefined };
				}) => ({ ok: ctx.credential.get("sessionCookie") === state.validCookie }),
				healthCheck: {
					interval: "5m",
					requiresConnection: true,
					cases: [
						{
							name: "prep case",
							input: {},
							prepareInput: async ({
								input,
								gateway,
							}: {
								input: unknown;
								gateway: {
									execute: (
										providerId: string,
										operationId: string,
										operationInput: unknown,
									) => Promise<{ status: number }>;
								};
							}) => {
								// Contract: the hook SEES every helper status (may branch on
								// it) — the typical pattern throws on non-2xx.
								const executed = await gateway.execute(PROVIDER_ID, "session", {});
								state.prepStatuses.push(executed.status);
								if (executed.status !== 200) {
									throw new Error(`helper status ${executed.status}`);
								}
								return input;
							},
							assertions: () => {},
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

	it("reports a post-submission retry turn as auth_flow_rejected and memoizes it", async () => {
		const state = createFlowProviderState();
		const { selfTestApp } = createApps(createFlowProvider(state));
		const wrongInputs = { phone: CREDENTIAL_INPUTS.phone, password: "wrong-password" };

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1", wrongInputs);
		expect(first.result?.status).toBe("skipped");
		expect(first.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON);
		expect(state.continueCount).toBe(1);

		// Rejected credentials are memoized: the next cycle must not re-submit
		// them upstream (lockout safety) — same distinct skip, zero contact.
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2", wrongInputs);
		expect(second.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON);
		expect(state.startCount).toBe(1);
		expect(state.continueCount).toBe(1);
	});

	it("never submits credentials after the case deadline fired mid-start", async () => {
		const state = createFlowProviderState();
		state.startDelayMs = 300;
		state.caseTimeoutMs = 150;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const body = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(body.result?.status).toBe("error");
		expect(body.result?.error?.code).toBe("self_test_timeout");

		// Let the abandoned background flow run to completion: it must bail
		// BEFORE continue — a late credential submission is a real upstream
		// login/OTP attempt nobody is waiting for.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(state.startCount).toBe(1);
		expect(state.continueCount).toBe(0);
		expect(state.loginCount).toBe(0);
	});

	it("discards a credential from a flow that completed after the case deadline", async () => {
		const state = createFlowProviderState();
		// The flow outlives the 150ms case budget but eventually completes:
		// start returns fast (so credentials are legitimately submitted before
		// the deadline), then continue is slow and finishes after it.
		state.continueDelayMs = 300;
		state.caseTimeoutMs = 150;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("error");
		expect(first.result?.error?.code).toBe("self_test_timeout");

		// Let the abandoned flow finish its late login attempt…
		await new Promise((resolve) => setTimeout(resolve, 400));
		const loginsAfterLateCompletion = state.loginCount;

		// …then a healthy cycle must materialize a FRESH credential: nothing
		// from the timed-out login may have been cached. The upstream accepts
		// only the next-issued session, so reusing the abandoned v1 cookie
		// would fail the probe.
		state.continueDelayMs = 0;
		state.validCookie = "flow-session-secret-v2";
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.status).toBe("ok");
		expect(state.loginCount).toBe(loginsAfterLateCompletion + 1);
	});

	it("keeps the connection id stable across cycles so cached sessions ride one affinity", async () => {
		const state = createFlowProviderState();
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(first.result?.status).toBe("ok");
		expect(second.result?.status).toBe("ok");
		expect(state.loginCount).toBe(1);
		// The connection id seeds proxy/connection affinity: the cached cookie
		// must be replayed under the SAME id, never a per-request one.
		expect(state.seenConnectionIds).toHaveLength(2);
		expect(state.seenConnectionIds[0]).toBe(state.seenConnectionIds[1] as string);
		expect(state.seenConnectionIds[0]).toStartWith("self-test-");

		// Rotated inputs are a different credential identity — different
		// affinity, and no raw input material in the id itself.
		state.multiTurn = true;
		await runCase(selfTestApp, "session", "session case", "req-cycle-3", {
			phone: CREDENTIAL_INPUTS.phone,
			password: "rotated-password-5678",
		});
		expect(state.seenConnectionIds.every((id) => !id.includes("rotated-password-5678"))).toBe(
			true,
		);
	});

	it("evicts a fresh credential the probe rejected — next cycle logs in anew, no stale replay", async () => {
		const state = createFlowProviderState();
		// Upstream rejects every session, including fresh ones.
		state.validCookie = "never-issued";
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("failed");
		expect(state.loginCount).toBe(1);

		// The rejected fresh session must NOT be replayed: cycle 2 performs
		// exactly one probe attempt with a brand-new login (a surviving cache
		// entry would add a guaranteed-stale attempt before the retry).
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.status).toBe("failed");
		expect(state.loginCount).toBe(2);
		expect(state.seenConnectionIds).toHaveLength(2);
	});

	it("memoizes a thrown auth rejection (defineCredentialsAuth-style 401) like a retry turn", async () => {
		const state = createFlowProviderState();
		state.authErrorAtContinue = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("skipped");
		expect(first.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON);
		expect(state.continueCount).toBe(1);

		// Same bad password must not be re-submitted next cycle (lockout safety).
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON);
		expect(state.continueCount).toBe(1);
	});

	it("does not memoize a generic 400-mapped provider failure from continue", async () => {
		const state = createFlowProviderState();
		state.flowError = true; // generic throw -> non-auth status, never cached
		const { selfTestApp } = createApps(createFlowProvider(state));
		await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		// Both cycles re-drove the flow: transient provider failures must not
		// freeze the signal behind the rejection cache.
		expect(state.continueCount).toBe(2);
	});

	it("never posts credentials into a non-input start turn (redirect/poll/challenge)", async () => {
		const state = createFlowProviderState();
		state.nonInputTurnAtStart = "redirect";
		const { selfTestApp } = createApps(createFlowProvider(state));

		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("skipped");
		expect(first.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON);
		expect(state.continueCount).toBe(0);

		// A genuine headless gap: memoized like any multi-turn flow.
		const second = await runCase(selfTestApp, "session", "session case", "req-cycle-2");
		expect(second.result?.skipReason).toBe(SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON);
		expect(state.startCount).toBe(1);
		expect(state.continueCount).toBe(0);
	});

	it("rejects an unknown start turn BEFORE submitting credentials", async () => {
		const state = createFlowProviderState();
		state.unknownTurnAtStart = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const body = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(body.result?.status).toBe("error");
		expect(body.result?.error?.code).toBe("auth_flow_unexpected_turn");
		// Credentials must never reach continue through an unrecognized stage.
		expect(state.continueCount).toBe(0);
	});

	it("case timing covers auth-flow materialization, not just the final probe attempt", async () => {
		const state = createFlowProviderState();
		state.startDelayMs = 200;
		const { selfTestApp } = createApps(createFlowProvider(state));

		const body = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(body.result?.status).toBe("ok");
		// A slow login must not read as a fast healthy case.
		expect(body.result?.responseTimeMs).toBeGreaterThanOrEqual(200);
	});

	it("splits the session cache per operation for operation-affinity proxies", async () => {
		const state = createFlowProviderState();
		state.operationAffinity = true;
		const { selfTestApp } = createApps(createFlowProvider(state));

		await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		await runCase(selfTestApp, "leaky", "leaky case", "req-cycle-2");
		// Each operation pins its own proxy (providerId/operationId): one shared
		// cookie would hop between per-operation proxies, so each operation
		// materializes its own session.
		expect(state.loginCount).toBe(2);
		// The probe connection carries the SAME id the auth flow used — the
		// probe's exact proxy key.
		expect(state.seenConnectionIds[0]).toBe(`${PROVIDER_ID}/session`);
	});

	it("shares one login across operations for connection-scoped affinity", async () => {
		const state = createFlowProviderState();
		const { selfTestApp } = createApps(createFlowProvider(state));

		await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		await runCase(selfTestApp, "leaky", "leaky case", "req-cycle-2");
		expect(state.loginCount).toBe(1);
	});

	it("recovers a stale cached session when prepareInput's gateway helper hits 401", async () => {
		const state = createFlowProviderState();
		const { selfTestApp } = createApps(createFlowProvider(state));

		// Cycle 1 materializes and caches v1.
		const first = await runCase(selfTestApp, "session", "session case", "req-cycle-1");
		expect(first.result?.status).toBe("ok");
		expect(state.loginCount).toBe(1);

		// The upstream rotates: cached v1 is now stale, next login issues v2.
		state.validCookie = "flow-session-secret-v2";

		// prepareInput's gateway.execute hits 401 with the cached session; the
		// hook SEES the status (contract preserved), throws, and that failure
		// carries the auth status — triggering the same one-shot recovery as a
		// probe-level 401.
		const second = await runCase(selfTestApp, "prep", "prep case", "req-cycle-2");
		expect(second.result?.status).toBe("ok");
		expect(state.loginCount).toBe(2);
		expect(state.prepStatuses).toContain(401);
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
