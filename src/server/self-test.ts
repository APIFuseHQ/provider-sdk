import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { TURN_KINDS } from "../auth-turn";

import { type Context, Hono } from "hono";
import { z } from "zod";
import type {
	HealthCheckAssertionContext,
	HealthCheckCase,
	HealthCheckSuite,
	OperationDefinition,
	ProviderDefinition,
} from "../types";
import { resolveHealthCheckInputDateTokens } from "./self-test-input-tokens";
import { collectSelfTestSensitiveValues, redactSelfTestText } from "./self-test-redaction";
import {
	DEFAULT_SELF_TEST_PORT,
	PROVIDER_RUNTIME_SELF_TEST_PORT_ENV,
	type SelfTestMasterSecrets,
	verifySelfTestAuthorization,
} from "./self-test-token";
import type { OperationConnection } from "./types";

export const SELF_TEST_SCHEMA_VERSION = 1 as const;
export const SELF_TEST_PATH = "/internal/health/self-test";
export const SELF_TEST_HEALTHZ_PATH = "/healthz";

/** Overall wall-clock budget for one self-test request (all selected cases). */
export const PROVIDER_RUNTIME_SELF_TEST_REQUEST_BUDGET_MS_ENV =
	"APIFUSE__PROVIDER_RUNTIME__SELF_TEST_REQUEST_BUDGET_MS";
export const DEFAULT_SELF_TEST_REQUEST_BUDGET_MS = 120_000;

const DEFAULT_CASE_TIMEOUT_MS = 30_000;
const SELF_TEST_BUSY_RETRY_AFTER_MS = 1_000;

export const SelfTestRequestSchema = z.object({
	schemaVersion: z.number().int(),
	requestId: z.string().min(1),
	/** Single-case form (one case per request): both fields required together. */
	operationId: z.string().min(1).optional(),
	caseName: z.string().min(1).optional(),
	/** Batch form: optional selectors; omitted = every declared case. */
	operations: z.array(z.string().min(1)).optional(),
	caseNames: z.array(z.string().min(1)).optional(),
	/** Per-case timeout override; case/suite/provider defaults apply otherwise. */
	timeoutMs: z.number().int().min(1).max(600_000).optional(),
	/** Credential material for requiresConnection cases; never persisted. */
	credentials: z.object({ inputs: z.record(z.string(), z.string()) }).optional(),
});

export type SelfTestRequest = z.infer<typeof SelfTestRequestSchema>;

export type SelfTestCaseStatus = "ok" | "degraded" | "failed" | "error" | "skipped";

export interface SelfTestCaseResult {
	operationId: string;
	caseName: string;
	status: SelfTestCaseStatus;
	label: string;
	responseTimeMs: number;
	httpStatus?: number;
	assertion?: { passed: boolean; message?: string };
	skipReason?: string;
	error?: { code: string; message: string };
	startedAt: string;
	finishedAt: string;
}

export interface SelfTestResponse {
	schemaVersion: typeof SELF_TEST_SCHEMA_VERSION;
	providerId: string;
	sdkVersion: string;
	planDigest: string;
	/** Present for single-case requests (mirrors results[0]). */
	result?: SelfTestCaseResult;
	results: SelfTestCaseResult[];
}

export type SelfTestOperationInvoke = (args: {
	operationId: string;
	input: unknown;
	connection?: OperationConnection;
	requestId: string;
}) => Promise<{
	status: number;
	data: unknown;
	meta?: Record<string, unknown>;
}>;

export type SelfTestAuthFlowRoute = "start" | "continue";

/**
 * In-process driver for the tenant app's /auth pipeline. Self-test uses it to
 * materialize `requiresConnection` credentials through the provider's declared
 * auth flow — the exact path production connections take — instead of
 * injecting raw credential inputs as connection secrets.
 */
export type SelfTestAuthFlowInvoke = (args: {
	route: SelfTestAuthFlowRoute;
	requestId: string;
	flowId: string;
	/** Stable per-credential connection id — keeps login on the probe's affinity. */
	connectionId?: string;
	input?: Record<string, unknown>;
	context?: Record<string, unknown>;
}) => Promise<{
	status: number;
	body: unknown;
}>;

/**
 * Skip reason reported when a declared auth flow does not complete in a single
 * continue (OTP, retry loop). Cross-repo contract: the health-monitor maps
 * this exact string to `self_test_incapable`; never vary it.
 */
export const SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON = "auth_flow_multi_turn";

/**
 * A `retry` turn after credential submission: the flow REJECTED the
 * configured inputs (bad password, exchange failure). Distinct from the
 * multi-turn gap so monitoring surfaces it as a real credential outage, and
 * memoized like multi-turn so the probe does not re-submit rejected
 * credentials every cycle (lockout safety).
 */
export const SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON = "auth_flow_rejected";

/**
 * Known interactive turn kinds that justify the memoized multi-turn skip —
 * they mean a human must participate (OTP, challenge, redirect, …).
 * `retry` is deliberately excluded: after a credential submission it means
 * rejection, not interaction (see SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON).
 * Kinds outside TURN_KINDS entirely are treated as flow errors.
 */
/**
 * Post-submission /auth/continue statuses that mean the flow REJECTED the
 * credentials (thrown AuthError -> 401, forbidden -> 403): memoized as
 * `auth_flow_rejected`. Deliberately NOT 400 — the auth route maps generic
 * ProviderErrors and Zod request errors there, which are often transient or
 * fixable and must stay uncached retries (like 408/429/5xx).
 */
const AUTH_REJECTION_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 403]);

const INTERACTIVE_TURN_KIND_SET: ReadonlySet<string> = new Set(
	TURN_KINDS.filter(
		(descriptor) => descriptor.rendering !== "terminal" && descriptor.kind !== "retry",
	).map((descriptor) => descriptor.kind),
);

export interface SelfTestAppOptions {
	/** Derived-token verification secrets; without them every self-test route 404s. */
	secrets?: SelfTestMasterSecrets;
	/** In-process invoke bound to the tenant-facing app's /v1 pipeline. */
	invoke: SelfTestOperationInvoke;
	/**
	 * In-process auth-flow driver bound to the tenant-facing app's /auth
	 * pipeline. Required for providers that declare `auth.mode: "credentials"`
	 * with a flow; without it their requiresConnection cases report a visible
	 * auth_flow_unavailable error instead of probing with raw inputs.
	 */
	authFlow?: SelfTestAuthFlowInvoke;
	/** Overall request budget; defaults to env / 120s. */
	requestBudgetMs?: number;
	/** Env override for secret collection + budget resolution (tests). */
	env?: Readonly<Record<string, string | undefined>>;
}

function resolveSdkVersion(): string {
	try {
		const packageJsonUrl = new URL("../../package.json", import.meta.url);
		const parsed: unknown = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			"version" in parsed &&
			typeof (parsed as { version: unknown }).version === "string"
		) {
			return (parsed as { version: string }).version;
		}
	} catch {
		// fall through to unknown
	}
	return "unknown";
}

const SDK_VERSION = resolveSdkVersion();

type AnyHealthCheckSuite = HealthCheckSuite<unknown, unknown>;
type AnyHealthCheckCase = HealthCheckCase<unknown, unknown>;

function healthCheckSuite(operation: OperationDefinition): AnyHealthCheckSuite | undefined {
	return operation.healthCheck as AnyHealthCheckSuite | undefined;
}

/**
 * Stable sha256 over the provider's declared health plan (operations, case
 * names, timeouts) so the scheduler can detect plan/image skew by comparing
 * the manifest planDigest against the pod-reported one.
 */
export function computeSelfTestPlanDigest(provider: ProviderDefinition): string {
	const plan = Object.keys(provider.operations)
		.sort()
		.flatMap((operationId) => {
			const operation = provider.operations[operationId];
			const suite = operation ? healthCheckSuite(operation) : undefined;
			if (!suite) return [];
			return [
				{
					operationId,
					interval: suite.interval,
					timeoutMs: suite.timeoutMs ?? null,
					requiresConnection: suite.requiresConnection ?? false,
					cases: suite.cases.map((healthCase) => ({
						name: healthCase.name,
						timeoutMs: healthCase.timeoutMs ?? null,
						degradedThresholdMs: healthCase.degradedThresholdMs ?? null,
						expectedStatus: healthCase.expectedStatus ?? "ok",
					})),
				},
			];
		});
	const canonical = JSON.stringify({
		schemaVersion: SELF_TEST_SCHEMA_VERSION,
		providerId: provider.id,
		plan,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Fail-closed read-only classification: an operation may self-test only when
 * its own metadata marks it read-only (annotations.readOnly or
 * toolRouter.riskClass "read") and nothing marks it side-effecting. Unclassified
 * operations are refused so the endpoint cannot become a mutation oracle.
 */
export function isSelfTestReadOnlyOperation(operation: OperationDefinition): boolean {
	const annotations = operation.annotations;
	if (annotations?.readOnly === false) return false;
	if (annotations?.destructive === true) return false;
	const riskClass = operation.toolRouter?.riskClass;
	if (riskClass !== undefined && riskClass !== "read") return false;
	return annotations?.readOnly === true || riskClass === "read";
}

/** Binds the self-test executor to a tenant app's /v1 pipeline in-process. */
export function createSelfTestInvoke(app: {
	request: (input: string, requestInit?: RequestInit) => Response | Promise<Response>;
}): SelfTestOperationInvoke {
	return async ({ operationId, input, connection, requestId }) => {
		const response = await app.request(`/v1/${encodeURIComponent(operationId)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId,
				input: input ?? {},
				...(connection ? { connection } : {}),
			}),
		});
		const text = await response.text();
		let body: unknown = text;
		try {
			body = text.length > 0 ? JSON.parse(text) : undefined;
		} catch {
			// non-JSON transports keep the raw text as data
		}
		if (response.ok && body && typeof body === "object" && !Array.isArray(body) && "data" in body) {
			const envelope = body as { data: unknown; meta?: Record<string, unknown> };
			return {
				status: response.status,
				data: envelope.data,
				...(envelope.meta ? { meta: envelope.meta } : {}),
			};
		}
		return { status: response.status, data: body };
	};
}

/** Binds the self-test auth-flow driver to a tenant app's /auth pipeline in-process. */
export function createSelfTestAuthFlowInvoke(app: {
	request: (input: string, requestInit?: RequestInit) => Response | Promise<Response>;
}): SelfTestAuthFlowInvoke {
	return async ({ route, requestId, flowId, connectionId, input, context }) => {
		const response = await app.request(`/auth/${route}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				requestId,
				flowId,
				...(connectionId ? { connectionId } : {}),
				...(input ? { input } : {}),
				...(context ? { context } : {}),
			}),
		});
		const text = await response.text();
		let body: unknown = text;
		try {
			body = text.length > 0 ? JSON.parse(text) : undefined;
		} catch {
			// non-JSON transports keep the raw text as body
		}
		return { status: response.status, body };
	};
}

class SelfTestCaseTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Self-test case timed out after ${timeoutMs}ms`);
		this.name = "SelfTestCaseTimeoutError";
	}
}

async function withCaseTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new SelfTestCaseTimeoutError(timeoutMs)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function objectProperty(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	for (const [entryKey, entryValue] of Object.entries(value)) {
		if (entryKey === key) return entryValue;
	}
	return undefined;
}

function upstreamErrorCode(body: unknown): string | undefined {
	const error = objectProperty(body, "error");
	const code = objectProperty(error, "code");
	return typeof code === "string" ? code : undefined;
}

function upstreamErrorMessage(body: unknown): string | undefined {
	const error = objectProperty(body, "error");
	const message = objectProperty(error, "message");
	return typeof message === "string" ? message : undefined;
}

/**
 * How long a memoized multi-turn flow outcome suppresses re-driving the auth
 * flow. Generous on purpose: a multi-turn ceremony (OTP, device approval) is a
 * provider property that changes on the timescale of releases, not probe
 * cycles, and every re-drive is a REAL upstream login submission. The cache is
 * in-process, so a pod restart also clears the entry.
 */
export const SELF_TEST_MULTI_TURN_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export type SelfTestCredentialSessionEntry =
	/** Flow-materialized credential reused across probe cycles. */
	| { kind: "credential"; credential: Record<string, string> }
	/**
	 * Negative entry: the flow did not complete in a single continue turn
	 * (`auth_flow_multi_turn`). Memoized so subsequent cycles report the skip
	 * WITHOUT contacting the upstream again — the first attempt already
	 * submitted real credentials (and may have triggered an OTP send).
	 */
	| { kind: "multi_turn"; cachedAtMs: number }
	/**
	 * Negative entry: the flow REJECTED the submitted credential inputs
	 * (`retry` turn after continue — bad password, exchange failure).
	 * Memoized so the probe does not re-submit rejected credentials every
	 * cycle; a new entry is attempted when the inputs rotate (new hash),
	 * the TTL lapses, or the process restarts.
	 */
	| { kind: "rejected"; cachedAtMs: number };

/**
 * In-process cache of per-(providerId + stable hash of credentialInputs) auth
 * flow outcomes, so consecutive probe cycles reuse the session — or the
 * memoized multi-turn skip — instead of logging in every cycle (upstream
 * account safety, DR-7). Credential entries are invalidated on a probe auth
 * failure, at most once; multi-turn entries expire after
 * `SELF_TEST_MULTI_TURN_RETRY_AFTER_MS` or on process restart. Flow ERRORS
 * (transport/protocol failures, thrown start/continue) are deliberately NEVER
 * cached: they are typically transient, and retrying a failed request next
 * cycle is not a repeated login submission.
 */
export type SelfTestCredentialSessionCache = Map<string, SelfTestCredentialSessionEntry>;

interface SelfTestExecutionContext {
	provider: ProviderDefinition;
	invoke: SelfTestOperationInvoke;
	authFlow?: SelfTestAuthFlowInvoke;
	requestId: string;
	credentials?: Readonly<Record<string, string>>;
	requestTimeoutMs?: number;
	/**
	 * Mutable on purpose: every secret value materialized by an auth flow is
	 * appended here BEFORE any probe output is built, so redactSelfTestText
	 * scrubs flow-issued cookies/tokens exactly like request-supplied inputs.
	 */
	sensitiveValues: string[];
	sessionCache: SelfTestCredentialSessionCache;
}

function resolveCaseTimeoutMs(
	execution: SelfTestExecutionContext,
	suite: AnyHealthCheckSuite,
	healthCase: AnyHealthCheckCase,
): number {
	const providerDefault = (execution.provider.healthProbe ?? execution.provider.healthMonitor)
		?.defaultProbeTimeoutMs;
	return (
		execution.requestTimeoutMs ??
		healthCase.timeoutMs ??
		suite.timeoutMs ??
		providerDefault ??
		DEFAULT_CASE_TIMEOUT_MS
	);
}

function credentialSessionCacheKey(
	providerId: string,
	inputs: Readonly<Record<string, string>>,
): string {
	const canonical = JSON.stringify(
		Object.keys(inputs)
			.sort()
			.map((key) => [key, inputs[key]]),
	);
	return `${providerId}:${createHash("sha256").update(canonical).digest("hex")}`;
}

function registerSensitiveValues(
	execution: SelfTestExecutionContext,
	values: Iterable<string>,
): void {
	for (const value of values) {
		if (
			typeof value === "string" &&
			value.length > 0 &&
			!execution.sensitiveValues.includes(value)
		) {
			execution.sensitiveValues.push(value);
		}
	}
}

type SelfTestConnectionResolution =
	| {
			kind: "connection";
			connection?: OperationConnection;
			credentialSource?: "inputs" | "flow" | "cache";
			cacheKey?: string;
	  }
	| { kind: "skip"; skipReason: string }
	| { kind: "flow_error"; code: string; message: string };

type ParsedAuthFlowTurn =
	| {
			ok: true;
			turn: { kind: string; data?: unknown };
			contextPatch?: Record<string, unknown>;
	  }
	| { ok: false; code: string; message: string; httpStatus: number };

function parseAuthFlowResponse(result: { status: number; body: unknown }): ParsedAuthFlowTurn {
	const errorEnvelope = objectProperty(result.body, "error");
	if (result.status < 200 || result.status >= 300 || errorEnvelope !== undefined) {
		const message = objectProperty(errorEnvelope, "message");
		return {
			ok: false,
			code: "auth_flow_failed",
			message:
				typeof message === "string"
					? message
					: `Auth flow request failed with status ${result.status}`,
			httpStatus: result.status,
		};
	}
	const turnValue = objectProperty(result.body, "data");
	const turnKind = objectProperty(turnValue, "kind");
	if (typeof turnKind !== "string") {
		return {
			ok: false,
			code: "auth_flow_failed",
			message: "Auth flow returned an unrecognized turn.",
			httpStatus: result.status,
		};
	}
	const contextPatch = objectProperty(result.body, "contextPatch");
	return {
		ok: true,
		turn: { kind: turnKind, data: objectProperty(turnValue, "data") },
		...(contextPatch && typeof contextPatch === "object" && !Array.isArray(contextPatch)
			? { contextPatch: contextPatch as Record<string, unknown> }
			: {}),
	};
}

function applyAuthFlowContextPatch(
	base: Record<string, unknown>,
	patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!patch) return base;
	const next = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete next[key];
		} else {
			next[key] = value;
		}
	}
	return next;
}

/**
 * Extracts the completed credential from a complete turn's data payload — the
 * same `data.credential` record the gateway persists as connection secrets in
 * production (`persistCredential` → credential-service `UpdateCredential`).
 */
function completedCredentialFromTurn(turnData: unknown): Record<string, string> | undefined {
	const credential = objectProperty(turnData, "credential");
	if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
		return undefined;
	}
	const secrets: Record<string, string> = {};
	for (const [key, value] of Object.entries(credential)) {
		if (typeof value === "string") secrets[key] = value;
	}
	return Object.keys(secrets).length > 0 ? secrets : undefined;
}

/**
 * Drives the provider's declared auth flow exactly like production does:
 * `flow.start()` then a single `flow.continue(credentialInputs)`. Anything
 * other than a complete turn is a visible multi-turn gap, never a fabricated
 * probe failure.
 */
async function materializeFlowCredential(
	execution: SelfTestExecutionContext,
	inputs: Readonly<Record<string, string>>,
	options: { isAbandoned?: () => boolean; connectionId?: string } = {},
): Promise<
	| { credential: Record<string, string> }
	| Exclude<SelfTestConnectionResolution, { kind: "connection" }>
> {
	const authFlow = execution.authFlow;
	if (!authFlow) {
		return {
			kind: "flow_error",
			code: "auth_flow_unavailable",
			message:
				"Provider declares a credentials auth flow but the self-test host has no auth-flow driver.",
		};
	}
	const flowId = `self-test-${randomUUID()}`;
	// The login must ride the SAME proxy/connection affinity the probe will
	// use (createAuthFlowContext keys affinity on connectionId) — otherwise
	// IP/session-bound upstreams see the cookie arrive from a different
	// session and reject it.
	const started = parseAuthFlowResponse(
		await authFlow({
			route: "start",
			requestId: `${execution.requestId}-auth-start-${randomUUID()}`,
			flowId,
			...(options.connectionId ? { connectionId: options.connectionId } : {}),
		}),
	);
	if (!started.ok) {
		return { kind: "flow_error", code: started.code, message: started.message };
	}
	let turn = started.turn;
	const flowContext = applyAuthFlowContextPatch({}, started.contextPatch);
	if (turn.kind === "abort") {
		// Terminal turn: continuing after an abort would replay credentials into
		// a flow that already refused to proceed. Not memoized (flow errors are
		// never cached) — an abort can be transient upstream maintenance.
		return {
			kind: "flow_error",
			code: "auth_flow_aborted",
			message: "Auth flow aborted before requesting input.",
		};
	}
	if (turn.kind !== "complete") {
		// Validate the start turn BEFORE submitting credentials: an unknown
		// kind may be a provider typo or a stage that must not receive the
		// probe inputs. `retry` counts as an input prompt at this stage.
		if (turn.kind !== "retry" && !INTERACTIVE_TURN_KIND_SET.has(turn.kind)) {
			return {
				kind: "flow_error",
				code: "auth_flow_unexpected_turn",
				message: `Auth flow start returned an unrecognized turn kind "${turn.kind}".`,
			};
		}
		// Auto-continue ONLY into input prompts (form/retry). Other known
		// interactive stages (redirect, poll, pending, challenge, message,
		// multi_choice) are valid flows that are NOT asking for the credential
		// inputs — posting the password there submits it to the wrong stage.
		// They are a genuine headless gap: the memoized multi-turn skip.
		if (turn.kind !== "form" && turn.kind !== "retry") {
			return { kind: "skip", skipReason: SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON };
		}
		// The case deadline may have fired while start() was still running.
		// Never submit real credentials into a flow whose case already
		// reported self_test_timeout — a late continue is a real upstream
		// login/OTP attempt nobody is waiting for.
		if (options.isAbandoned?.() === true) {
			return {
				kind: "flow_error",
				code: "self_test_timeout",
				message: "Case deadline passed before credential submission; flow abandoned.",
			};
		}
		const continued = parseAuthFlowResponse(
			await authFlow({
				route: "continue",
				requestId: `${execution.requestId}-auth-continue-${randomUUID()}`,
				flowId,
				...(options.connectionId ? { connectionId: options.connectionId } : {}),
				input: { ...inputs },
				...(Object.keys(flowContext).length > 0 ? { context: flowContext } : {}),
			}),
		);
		if (!continued.ok) {
			// Providers built with defineCredentialsAuth cannot return a retry
			// turn — a rejected password THROWS and /auth/continue answers with
			// an auth-shaped 401/403. That is a credential REJECTION (memoized,
			// so the probe never hammers a locked-out login); every other
			// status stays an uncached transient retry.
			if (AUTH_REJECTION_HTTP_STATUSES.has(continued.httpStatus)) {
				return { kind: "skip", skipReason: SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON };
			}
			return { kind: "flow_error", code: continued.code, message: continued.message };
		}
		turn = continued.turn;
	}
	if (turn.kind === "abort") {
		return {
			kind: "flow_error",
			code: "auth_flow_aborted",
			message: "Auth flow aborted after credential submission.",
		};
	}
	if (turn.kind === "retry") {
		// A retry turn AFTER submission is a credential rejection, not an
		// interactive gap — surfaced distinctly so monitoring can treat it as
		// a real outage, and memoized by the caller (lockout safety).
		return { kind: "skip", skipReason: SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON };
	}
	if (turn.kind !== "complete") {
		// Only KNOWN interactive kinds are a genuine "cannot complete headless"
		// multi-turn gap (memoized by the caller). An unknown kind is ambiguous
		// — it may encode a transient provider failure — so it reports as a
		// flow error, which is never memoized, instead of freezing the signal.
		if (!INTERACTIVE_TURN_KIND_SET.has(turn.kind)) {
			return {
				kind: "flow_error",
				code: "auth_flow_unexpected_turn",
				message: `Auth flow returned an unrecognized turn kind "${turn.kind}".`,
			};
		}
		return { kind: "skip", skipReason: SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON };
	}
	const credential = completedCredentialFromTurn(turn.data);
	if (!credential) {
		return {
			kind: "flow_error",
			code: "auth_flow_invalid_credential",
			message: "Auth flow completed without a string-valued credential payload.",
		};
	}
	// Redaction contract: flow-issued secrets are registered BEFORE any probe
	// output can be built from them.
	registerSensitiveValues(execution, Object.values(credential));
	return { credential };
}

async function resolveSelfTestConnection(
	execution: SelfTestExecutionContext,
	operationId: string,
	suite: AnyHealthCheckSuite,
	options: { forceLogin?: boolean; isAbandoned?: () => boolean } = {},
): Promise<SelfTestConnectionResolution> {
	if (!suite.requiresConnection) return { kind: "connection" };
	const inputs = execution.credentials ?? {};
	const declaredFields = Object.keys(
		(execution.provider.healthProbe ?? execution.provider.healthMonitor)?.credentialInputs ?? {},
	);
	for (const field of declaredFields) {
		if (!inputs[field]) {
			return { kind: "skip", skipReason: `credential_missing:${field}` };
		}
	}
	if (declaredFields.length === 0 && Object.keys(inputs).length === 0) {
		return { kind: "skip", skipReason: "credential_missing:credentials" };
	}

	// The connection id seeds proxy/connection affinity in the provider
	// context, so it must be STABLE per (provider, credentialInputs): a cached
	// session replayed under a per-request id would ride a different proxy/IP
	// each cycle and upstreams would treat the cookie as stale or suspicious.
	// The id carries only a hash of the inputs, never the inputs themselves.
	//
	// Providers declaring `proxy.session.affinity: "operation"` pin the PROBE's
	// proxy to `${providerId}/${operationId}` regardless of connection id — so
	// the login must ride that exact key, and the session cache splits per
	// operation (one shared cookie would otherwise hop between per-operation
	// proxies).
	const operationAffinity =
		typeof execution.provider.proxy === "object" &&
		execution.provider.proxy?.session?.affinity === "operation";
	const credentialKey = credentialSessionCacheKey(execution.provider.id, inputs);
	const affinityKey = operationAffinity ? `${credentialKey}:${operationId}` : credentialKey;
	// ONE id for the auth flow AND the probe connection: providers may bind
	// the issued credential to FlowContext.connectionId and later compare it
	// against ctx.request.connectionId. Operation-affinity providers use the
	// probe's exact proxy key (providerId/operationId); everyone else uses the
	// stable per-credential hash.
	const connectionId = operationAffinity
		? `${execution.provider.id}/${operationId}`
		: `self-test-${createHash("sha256").update(affinityKey).digest("hex").slice(0, 22)}`;
	const buildConnection = (secrets: Readonly<Record<string, string>>): OperationConnection => ({
		id: connectionId,
		mode: "credentials",
		secrets: { ...secrets },
		metadata: { purpose: "provider-self-test", operationId },
		externalRef: `${execution.provider.id}-${operationId}-self-test`,
	});

	const auth = execution.provider.auth;
	if (auth?.mode !== "credentials" || !auth.flow) {
		// Providers without a declared credentials flow keep raw-input semantics.
		return { kind: "connection", connection: buildConnection(inputs), credentialSource: "inputs" };
	}

	const cacheKey = affinityKey;
	const cached = execution.sessionCache.get(cacheKey);
	// DR-7 upstream-account safety: a memoized multi-turn outcome
	// short-circuits to the auth_flow_multi_turn skip WITHOUT re-driving
	// flow.start()/flow.continue() — every re-drive is a real upstream login
	// submission (OTP sends, lockout risk), and the probe scheduler would
	// otherwise repeat it every cycle forever. Changed credentialInputs hash
	// to a different key and re-attempt immediately; otherwise the entry
	// expires after a generous TTL (or process restart) so a provider whose
	// flow becomes single-turn again is eventually re-probed.
	if (cached?.kind === "multi_turn" || cached?.kind === "rejected") {
		if (Date.now() - cached.cachedAtMs < SELF_TEST_MULTI_TURN_RETRY_AFTER_MS) {
			return {
				kind: "skip",
				skipReason:
					cached.kind === "rejected"
						? SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON
						: SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON,
			};
		}
		execution.sessionCache.delete(cacheKey);
	}
	if (options.forceLogin !== true && cached?.kind === "credential") {
		registerSensitiveValues(execution, Object.values(cached.credential));
		return {
			kind: "connection",
			connection: buildConnection(cached.credential),
			credentialSource: "cache",
			cacheKey,
		};
	}
	const materialized = await materializeFlowCredential(execution, inputs, {
		...(options.isAbandoned !== undefined ? { isAbandoned: options.isAbandoned } : {}),
		connectionId,
	});
	if (!("credential" in materialized)) {
		// Only the multi-turn SKIP is negative-cached. Flow ERRORS
		// (auth_flow_unavailable / auth_flow_failed / invalid credential
		// payloads, or a thrown start/continue) are never memoized: they are
		// typically transient upstream or host failures, so each cycle may
		// retry — permanently caching an error would silently freeze the
		// signal on a blip, while retrying a FAILED request is not a repeated
		// successful login submission.
		if (materialized.kind === "skip" && options.isAbandoned?.() !== true) {
			if (materialized.skipReason === SELF_TEST_AUTH_FLOW_MULTI_TURN_SKIP_REASON) {
				execution.sessionCache.set(cacheKey, { kind: "multi_turn", cachedAtMs: Date.now() });
			} else if (materialized.skipReason === SELF_TEST_AUTH_FLOW_REJECTED_SKIP_REASON) {
				execution.sessionCache.set(cacheKey, { kind: "rejected", cachedAtMs: Date.now() });
			}
		}
		return materialized;
	}
	// A flow that outlived the case deadline still completes here (the timeout
	// only races the promise, it cannot cancel it). The case already reported
	// self_test_timeout — caching this credential would let the next probe
	// reuse a login whose latency just failed the case, hiding the failure.
	if (options.isAbandoned?.() === true) {
		return {
			kind: "flow_error",
			code: "self_test_timeout",
			message: "Auth flow completed after the case deadline; credential discarded.",
		};
	}
	execution.sessionCache.set(cacheKey, {
		kind: "credential",
		credential: materialized.credential,
	});
	return {
		kind: "connection",
		connection: buildConnection(materialized.credential),
		credentialSource: "flow",
		cacheKey,
	};
}

/** A failed probe whose HTTP status is auth-shaped invalidates a cached session once. */
function isAuthFailureCaseResult(result: SelfTestCaseResult): boolean {
	return result.status === "failed" && (result.httpStatus === 401 || result.httpStatus === 403);
}

async function executeSelfTestCase(
	execution: SelfTestExecutionContext,
	operationId: string,
	suite: AnyHealthCheckSuite,
	healthCase: AnyHealthCheckCase,
): Promise<SelfTestCaseResult> {
	const { provider, invoke } = execution;
	// execution.sensitiveValues may grow while the case runs (flow-issued
	// secrets); redact always reads the live array.
	const redact = (text: string) => redactSelfTestText(text, execution.sensitiveValues);
	const defaultLabel = redact(healthCase.description ?? healthCase.name);
	const timeoutMs = resolveCaseTimeoutMs(execution, suite, healthCase);
	// One deadline for the WHOLE case: connection materialization (auth flow),
	// the probe, and the one-shot auth retry all draw from the same budget —
	// a 30s case must never take ~4×30s across its stages.
	const caseDeadlineAtMs = performance.now() + timeoutMs;
	const remainingCaseTimeoutMs = () =>
		Math.max(1, Math.ceil(caseDeadlineAtMs - performance.now()));

	const beginCase = () => {
		const startedAt = new Date().toISOString();
		const startedAtMs = performance.now();
		return {
			startedAtMs,
			finish: (
				partial: Omit<
					SelfTestCaseResult,
					"operationId" | "caseName" | "startedAt" | "finishedAt" | "responseTimeMs"
				> & { responseTimeMs?: number },
			): SelfTestCaseResult => ({
				operationId,
				caseName: healthCase.name,
				startedAt,
				finishedAt: new Date().toISOString(),
				responseTimeMs:
					partial.responseTimeMs ?? Math.max(0, Math.round(performance.now() - startedAtMs)),
				...partial,
			}),
		};
	};
	const caseScope = beginCase();

	if (healthCase.enabled && healthCase.enabled() === false) {
		return caseScope.finish({
			status: "skipped",
			label: defaultLabel,
			skipReason: "disabled",
		});
	}

	const resolveConnection = async (forceLogin: boolean): Promise<SelfTestConnectionResolution> => {
		// The timeout only races the flow promise — it cannot cancel it. Once
		// the deadline fires, the still-running resolution is marked abandoned
		// so its late completion cannot write the session cache.
		let abandoned = false;
		try {
			return await withCaseTimeout(
				() =>
					resolveSelfTestConnection(execution, operationId, suite, {
						forceLogin,
						isAbandoned: () => abandoned,
					}),
				remainingCaseTimeoutMs(),
			);
		} catch (error) {
			abandoned = true;
			return {
				kind: "flow_error",
				code: error instanceof SelfTestCaseTimeoutError ? "self_test_timeout" : "auth_flow_failed",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	};

	const nonConnectionResult = (
		resolution: Exclude<SelfTestConnectionResolution, { kind: "connection" }>,
	): SelfTestCaseResult => {
		if (resolution.kind === "skip") {
			return caseScope.finish({
				status: "skipped",
				label: defaultLabel,
				skipReason: resolution.skipReason,
			});
		}
		return caseScope.finish({
			status: "error",
			label: defaultLabel,
			error: { code: resolution.code, message: redact(resolution.message) },
		});
	};

	const runProbeAttempt = async (
		connection: OperationConnection | undefined,
	): Promise<SelfTestCaseResult> => {
		// gateway.execute keeps its contract — EVERY helper status is returned
		// to the prepareInput hook (it may branch on 401 itself). The last
		// auth-shaped helper status is only RECORDED: if the hook then throws,
		// the case fails WITH that status so stale-session recovery triggers.
		let prepareAuthStatus: number | null = null;
		// Share the OUTER case scope: startedAt/responseTimeMs must cover the
		// WHOLE case — auth-flow materialization included — not just the final
		// operation attempt, or a slow login reads as a fast healthy case.
		const { startedAtMs, finish } = caseScope;
		try {
			return await withCaseTimeout(async () => {
				const resolvedInput = resolveHealthCheckInputDateTokens(healthCase.input);
				const preparedInput = healthCase.prepareInput
					? await healthCase.prepareInput({
							providerId: provider.id,
							operationId,
							input: resolvedInput,
							...(connection ? { connectionId: connection.id } : {}),
							gateway: {
								execute: async (foreignProviderId, gatewayOperationId, gatewayInput) => {
									if (foreignProviderId !== provider.id) {
										throw new Error(
											`Self-test prepareInput may only invoke provider "${provider.id}" operations (requested "${foreignProviderId}").`,
										);
									}
									const startedGatewayMs = performance.now();
									const executed = await invoke({
										operationId: gatewayOperationId,
										input: gatewayInput,
										connection,
										requestId: `${execution.requestId}-prepare-${randomUUID()}`,
									});
									if (executed.status === 401 || executed.status === 403) {
										prepareAuthStatus = executed.status;
									}
									return {
										status: executed.status,
										duration: performance.now() - startedGatewayMs,
										data: executed.data,
										meta: executed.meta,
									};
								},
							},
						})
					: resolvedInput;

				const executed = await invoke({
					operationId,
					input: preparedInput,
					connection,
					requestId: `${execution.requestId}-${randomUUID()}`,
				});
				const durationMs = performance.now() - startedAtMs;

				if (executed.status < 200 || executed.status >= 300) {
					return finish({
						status: "failed",
						label: defaultLabel,
						httpStatus: executed.status,
						error: {
							code: upstreamErrorCode(executed.data) ?? "operation_failed",
							message: redact(
								upstreamErrorMessage(executed.data) ??
									`Operation invocation failed with status ${executed.status}`,
							),
						},
					});
				}

				const assertionContext: HealthCheckAssertionContext = {
					status: executed.status,
					data: executed.data,
					durationMs,
					...(executed.meta ? { meta: executed.meta } : {}),
				};
				let assertionResult: unknown;
				try {
					assertionResult = await healthCase.assertions(assertionContext);
				} catch (assertionError) {
					return finish({
						status: "failed",
						label: defaultLabel,
						httpStatus: executed.status,
						assertion: {
							passed: false,
							message: redact(
								assertionError instanceof Error ? assertionError.message : String(assertionError),
							),
						},
					});
				}
				const statusValue = objectProperty(assertionResult, "status");
				const overrideStatus =
					statusValue === "ok" || statusValue === "degraded" ? statusValue : undefined;
				const labelValue = objectProperty(assertionResult, "label");
				const overrideLabel = typeof labelValue === "string" ? redact(labelValue) : undefined;
				return finish({
					status: overrideStatus ?? "ok",
					label: overrideLabel ?? defaultLabel,
					httpStatus: executed.status,
					assertion: { passed: true },
				});
			}, remainingCaseTimeoutMs());
		} catch (error) {
			if (error instanceof SelfTestCaseTimeoutError) {
				return finish({
					status: "error",
					label: defaultLabel,
					error: { code: "self_test_timeout", message: redact(error.message) },
				});
			}
			if (prepareAuthStatus !== null) {
				return finish({
					status: "failed",
					label: defaultLabel,
					httpStatus: prepareAuthStatus,
					assertion: {
						passed: false,
						message: redact(error instanceof Error ? error.message : String(error)),
					},
				});
			}
			return finish({
				status: "error",
				label: defaultLabel,
				error: {
					code: "self_test_execution_error",
					message: redact(error instanceof Error ? error.message : String(error)),
				},
			});
		}
	};

	const resolution = await resolveConnection(false);
	if (resolution.kind !== "connection") {
		return nonConnectionResult(resolution);
	}

	let result = await runProbeAttempt(resolution.connection);

	// One-shot session recovery: a cached credential that fails the probe with
	// an auth-shaped status is invalidated, the flow re-runs ONCE, and the
	// probe retries once. Fresh (just-materialized) credentials never retry.
	if (
		resolution.credentialSource === "cache" &&
		resolution.cacheKey !== undefined &&
		isAuthFailureCaseResult(result)
	) {
		execution.sessionCache.delete(resolution.cacheKey);
		const retryResolution = await resolveConnection(true);
		if (retryResolution.kind !== "connection") {
			return nonConnectionResult(retryResolution);
		}
		result = await runProbeAttempt(retryResolution.connection);
		// The retry's fresh credential is subject to the same eviction rule
		// as a first-attempt fresh credential (below).
		if (retryResolution.cacheKey !== undefined && isAuthFailureCaseResult(result)) {
			execution.sessionCache.delete(retryResolution.cacheKey);
		}
		return result;
	}

	// A FRESH credential the probe just rejected is known-bad: evict it so the
	// next cycle logs in anew instead of replaying a guaranteed-stale session
	// once before recovering. (No retry here — fresh credentials never retry.)
	if (
		resolution.credentialSource === "flow" &&
		resolution.cacheKey !== undefined &&
		isAuthFailureCaseResult(result)
	) {
		execution.sessionCache.delete(resolution.cacheKey);
	}

	return result;
}

interface SelectedCase {
	operationId: string;
	operation: OperationDefinition;
	suite: AnyHealthCheckSuite;
	healthCase: AnyHealthCheckCase;
}

type CaseSelection =
	| { cases: SelectedCase[] }
	| { errorStatus: 403 | 422; errorCode: string; errorMessage: string };

function selectCases(provider: ProviderDefinition, request: SelfTestRequest): CaseSelection {
	const singleCase = request.operationId !== undefined && request.caseName !== undefined;
	if (singleCase) {
		const operationId = request.operationId as string;
		const operation = provider.operations[operationId];
		const suite = operation ? healthCheckSuite(operation) : undefined;
		const healthCase = suite?.cases.find((candidate) => candidate.name === request.caseName);
		if (!operation || !suite || !healthCase) {
			return {
				errorStatus: 422,
				errorCode: "case_not_found",
				errorMessage: `Case "${request.caseName}" not found for operation "${operationId}".`,
			};
		}
		if (!isSelfTestReadOnlyOperation(operation)) {
			return {
				errorStatus: 403,
				errorCode: "operation_not_read_only",
				errorMessage: `Operation "${operationId}" is not classified read-only; self-test refuses to execute it.`,
			};
		}
		return { cases: [{ operationId, operation, suite, healthCase }] };
	}

	const operationFilter = request.operations ? new Set(request.operations) : undefined;
	const caseNameFilter = request.caseNames ? new Set(request.caseNames) : undefined;
	if (operationFilter) {
		for (const operationId of operationFilter) {
			const operation = provider.operations[operationId];
			if (!operation || !healthCheckSuite(operation)) {
				return {
					errorStatus: 422,
					errorCode: "case_not_found",
					errorMessage: `Operation "${operationId}" has no declared healthCheck cases.`,
				};
			}
		}
	}
	const cases: SelectedCase[] = [];
	for (const operationId of Object.keys(provider.operations).sort()) {
		if (operationFilter && !operationFilter.has(operationId)) continue;
		const operation = provider.operations[operationId];
		const suite = operation ? healthCheckSuite(operation) : undefined;
		if (!operation || !suite) continue;
		for (const healthCase of suite.cases) {
			if (caseNameFilter && !caseNameFilter.has(healthCase.name)) continue;
			cases.push({ operationId, operation, suite, healthCase });
		}
	}
	if (cases.length === 0) {
		return {
			errorStatus: 422,
			errorCode: "case_not_found",
			errorMessage: "No declared healthCheck cases matched the selection.",
		};
	}
	return { cases };
}

function resolveRequestBudgetMs(options: SelfTestAppOptions): number {
	if (options.requestBudgetMs !== undefined) return options.requestBudgetMs;
	const env = options.env ?? process.env;
	const raw = env[PROVIDER_RUNTIME_SELF_TEST_REQUEST_BUDGET_MS_ENV];
	const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SELF_TEST_REQUEST_BUDGET_MS;
}

export function resolveSelfTestPort(
	env: Readonly<Record<string, string | undefined>> = process.env,
): number {
	const raw = env[PROVIDER_RUNTIME_SELF_TEST_PORT_ENV];
	const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
		? parsed
		: DEFAULT_SELF_TEST_PORT;
}

/**
 * Builds the internal self-test Hono app. This app is served on a SEPARATE
 * listener (default :3001) that the tenant-facing gateway never dials; when no
 * master secret is resolvable the self-test route responds 404 (safe default
 * off) while `GET /healthz` stays available for liveness.
 */
export function createSelfTestApp(provider: ProviderDefinition, options: SelfTestAppOptions): Hono {
	const app = new Hono();
	const planDigest = computeSelfTestPlanDigest(provider);
	const requestBudgetMs = resolveRequestBudgetMs(options);
	// In-process flow-credential session cache (providerId + credentialInputs
	// hash → materialized credential). Lives as long as the app so consecutive
	// probe cycles never log in to the upstream more than once per session.
	const sessionCache: SelfTestCredentialSessionCache = new Map();
	let busy = false;

	app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));

	app.get(SELF_TEST_HEALTHZ_PATH, (c) => c.json({ ok: true }));

	const handleSelfTest = async (c: Context) => {
		if (!options.secrets) {
			return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
		}
		const authorized = verifySelfTestAuthorization(
			c.req.raw.headers.get("authorization") ?? undefined,
			provider.id,
			options.secrets,
		);
		if (!authorized) {
			return c.json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
		}

		const rawBody: unknown = await c.req.raw
			.clone()
			.json()
			.catch(() => undefined);
		const schemaVersion = objectProperty(rawBody, "schemaVersion");
		if (schemaVersion !== SELF_TEST_SCHEMA_VERSION) {
			return c.json(
				{
					error: {
						code: "unsupported_schema_version",
						message: `Unsupported self-test schemaVersion; supported: [${SELF_TEST_SCHEMA_VERSION}].`,
						supported: [SELF_TEST_SCHEMA_VERSION],
					},
				},
				400,
			);
		}
		const parsed = SelfTestRequestSchema.safeParse(rawBody);
		if (!parsed.success) {
			return c.json(
				{
					error: {
						code: "invalid_request",
						message: "Invalid self-test request body",
					},
				},
				400,
			);
		}
		const request = parsed.data;
		if ((request.operationId === undefined) !== (request.caseName === undefined)) {
			return c.json(
				{
					error: {
						code: "invalid_request",
						message: "operationId and caseName must be provided together for single-case requests.",
					},
				},
				400,
			);
		}

		const selection = selectCases(provider, request);
		if ("errorStatus" in selection) {
			return c.json(
				{
					error: {
						code: selection.errorCode,
						message: selection.errorMessage,
					},
				},
				selection.errorStatus,
			);
		}

		if (busy) {
			return c.json(
				{
					error: {
						code: "self_test_busy",
						message: "A self-test request is already executing.",
					},
					retryAfterMs: SELF_TEST_BUSY_RETRY_AFTER_MS,
				},
				409,
			);
		}
		busy = true;
		try {
			const execution: SelfTestExecutionContext = {
				provider,
				invoke: options.invoke,
				...(options.authFlow ? { authFlow: options.authFlow } : {}),
				requestId: request.requestId,
				credentials: request.credentials?.inputs,
				requestTimeoutMs: request.timeoutMs,
				sensitiveValues: collectSelfTestSensitiveValues(provider, {
					env: options.env,
					credentialInputs: request.credentials?.inputs,
				}),
				sessionCache,
			};
			const deadline = performance.now() + requestBudgetMs;
			const results: SelfTestCaseResult[] = [];
			// Sequential execution (parallelism 1): self-tests run on serving pods
			// and must never compete with themselves for upstream quota.
			for (const selected of selection.cases) {
				if (performance.now() >= deadline) {
					const now = new Date().toISOString();
					results.push({
						operationId: selected.operationId,
						caseName: selected.healthCase.name,
						status: "skipped",
						label: selected.healthCase.name,
						responseTimeMs: 0,
						skipReason: "budget_exhausted",
						startedAt: now,
						finishedAt: now,
					});
					continue;
				}
				if (!isSelfTestReadOnlyOperation(selected.operation)) {
					const now = new Date().toISOString();
					results.push({
						operationId: selected.operationId,
						caseName: selected.healthCase.name,
						status: "error",
						label: selected.healthCase.name,
						responseTimeMs: 0,
						error: {
							code: "operation_not_read_only",
							message: `Operation "${selected.operationId}" is not classified read-only; self-test refuses to execute it.`,
						},
						startedAt: now,
						finishedAt: now,
					});
					continue;
				}
				results.push(
					await executeSelfTestCase(
						execution,
						selected.operationId,
						selected.suite,
						selected.healthCase,
					),
				);
			}
			const singleCase = request.operationId !== undefined && request.caseName !== undefined;
			const response: SelfTestResponse = {
				schemaVersion: SELF_TEST_SCHEMA_VERSION,
				providerId: provider.id,
				sdkVersion: SDK_VERSION,
				planDigest,
				...(singleCase && results[0] ? { result: results[0] } : {}),
				results,
			};
			return c.json(response, 200);
		} finally {
			busy = false;
		}
	};

	app.post(SELF_TEST_PATH, handleSelfTest);
	// Transitional alias so schedulers can address the endpoint by its short
	// path; the canonical path is /internal/health/self-test.
	app.post("/self-test", handleSelfTest);

	return app;
}
