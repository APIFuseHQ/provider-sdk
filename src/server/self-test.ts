import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

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

export interface SelfTestAppOptions {
	/** Derived-token verification secrets; without them every self-test route 404s. */
	secrets?: SelfTestMasterSecrets;
	/** In-process invoke bound to the tenant-facing app's /v1 pipeline. */
	invoke: SelfTestOperationInvoke;
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

interface SelfTestExecutionContext {
	provider: ProviderDefinition;
	invoke: SelfTestOperationInvoke;
	requestId: string;
	credentials?: Readonly<Record<string, string>>;
	requestTimeoutMs?: number;
	sensitiveValues: readonly string[];
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

function buildSelfTestConnection(
	execution: SelfTestExecutionContext,
	operationId: string,
	suite: AnyHealthCheckSuite,
): { connection?: OperationConnection } | { skipReason: string } {
	if (!suite.requiresConnection) return {};
	const inputs = execution.credentials ?? {};
	const declaredFields = Object.keys(
		(execution.provider.healthProbe ?? execution.provider.healthMonitor)?.credentialInputs ?? {},
	);
	for (const field of declaredFields) {
		if (!inputs[field]) {
			return { skipReason: `credential_missing:${field}` };
		}
	}
	if (declaredFields.length === 0 && Object.keys(inputs).length === 0) {
		return { skipReason: "credential_missing:credentials" };
	}
	return {
		connection: {
			id: `self-test-${execution.requestId}`,
			mode: "credentials",
			secrets: { ...inputs },
			metadata: { purpose: "provider-self-test", operationId },
			externalRef: `${execution.provider.id}-${operationId}-self-test`,
		},
	};
}

async function executeSelfTestCase(
	execution: SelfTestExecutionContext,
	operationId: string,
	suite: AnyHealthCheckSuite,
	healthCase: AnyHealthCheckCase,
): Promise<SelfTestCaseResult> {
	const { provider, invoke, sensitiveValues } = execution;
	const redact = (text: string) => redactSelfTestText(text, sensitiveValues);
	const startedAt = new Date().toISOString();
	const startedAtMs = performance.now();
	const finish = (
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
	});
	const defaultLabel = redact(healthCase.description ?? healthCase.name);

	if (healthCase.enabled && healthCase.enabled() === false) {
		return finish({
			status: "skipped",
			label: defaultLabel,
			skipReason: "disabled",
		});
	}

	const connectionResolution = buildSelfTestConnection(execution, operationId, suite);
	if ("skipReason" in connectionResolution) {
		return finish({
			status: "skipped",
			label: defaultLabel,
			skipReason: connectionResolution.skipReason,
		});
	}
	const connection = connectionResolution.connection;

	const timeoutMs = resolveCaseTimeoutMs(execution, suite, healthCase);
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
		}, timeoutMs);
	} catch (error) {
		if (error instanceof SelfTestCaseTimeoutError) {
			return finish({
				status: "error",
				label: defaultLabel,
				error: { code: "self_test_timeout", message: redact(error.message) },
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
				requestId: request.requestId,
				credentials: request.credentials?.inputs,
				requestTimeoutMs: request.timeoutMs,
				sensitiveValues: collectSelfTestSensitiveValues(provider, {
					env: options.env,
					credentialInputs: request.credentials?.inputs,
				}),
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
