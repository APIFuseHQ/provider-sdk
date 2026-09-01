import { getStealthProfile } from "../../stealth/profiles.js";
import type { ChallengeSolution, ProviderChallenge, ProviderChallengeKind } from "../../types.js";
import { redactSensitiveText } from "../request-options.js";
import { DEFAULT_STEALTH_PROFILE } from "../stealth.js";
import type { TraceRecorder } from "../trace.js";
import { assertResolverHostAllowed } from "./hosts.js";
import {
	ResolverChallengeVerdictError,
	type ResolverIdentity,
	type ResolverVendorAdapter,
	ResolverVendorUnavailableError,
	type ResolverVendorUnavailableReason,
	resolverVendorSupports,
} from "./types.js";

const CAPSOLVER_VENDOR_ID = "capsolver" as const;
const DEFAULT_CAPSOLVER_BASE_URL = "https://api.capsolver.com";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const SDK_ESTIMATED_COOKIE_TTL_MS_BY_CHALLENGE_KIND = {
	// CapSolver omits expiry, so use one conservative hour despite measured
	// AWS WAF lifetimes of days.
	aws_waf: 60 * 60 * 1_000,
} satisfies Partial<Record<ProviderChallengeKind, number>>;

type Delay = (ms: number, signal: AbortSignal) => Promise<void>;
type CapsolverOperationPhase = "create_task" | "poll_result";

export interface CapsolverResolverVendorOptions {
	readonly apiKey?: string;
	readonly timeoutMs?: number;
	readonly pollIntervalMs?: number;
	readonly allowedHosts: readonly string[];
	readonly fetchImpl?: typeof fetch;
	readonly baseUrl?: string;
	/** Test-only clock override; supplying it disables the real-time deadline timer. */
	readonly now?: () => number;
	/** Test-only delay override used with `now` to exercise polling without sleeping. */
	readonly delay?: Delay;
}

export interface CapsolverResolverVendorAdapter extends ResolverVendorAdapter {
	readonly id: "capsolver";
	solve(
		challenge: ProviderChallenge,
		identity: ResolverIdentity | undefined,
		signal: AbortSignal,
		traceRecorder?: TraceRecorder,
	): Promise<ChallengeSolution>;
}

class CapsolverSolveTimeoutError extends Error {
	constructor() {
		super("Capsolver resolver solve budget elapsed");
		this.name = "CapsolverSolveTimeoutError";
	}
}

class CapsolverUnavailableError extends ResolverVendorUnavailableError {
	readonly errorCode: string | undefined;
	readonly errorDescription: string | undefined;
	readonly responseStatus: number | undefined;
	readonly responseContentType: string | undefined;
	readonly responseLength: number | undefined;

	constructor(
		reason: ResolverVendorUnavailableReason,
		options: {
			readonly phase: CapsolverOperationPhase;
			readonly cause?: unknown;
			readonly errorCode?: string;
			readonly errorDescription?: string;
			readonly responseStatus?: number;
			readonly responseContentType?: string;
			readonly responseLength?: number;
		},
	) {
		super(CAPSOLVER_VENDOR_ID, reason, options);
		this.errorCode = options.errorCode;
		this.errorDescription = options.errorDescription;
		this.responseStatus = options.responseStatus;
		this.responseContentType = options.responseContentType;
		this.responseLength = options.responseLength;
	}
}

type JsonRecord = Record<string, unknown>;

interface CapsolverResponseErrorFields {
	readonly errorId: number | undefined;
	readonly errorCode: string | undefined;
	readonly errorDescription: string | undefined;
}

interface CapsolverCreateTaskResponse extends CapsolverResponseErrorFields {
	readonly taskId: string | number | undefined;
}

interface CapsolverPollResultResponse extends CapsolverResponseErrorFields {
	readonly status: string | undefined;
	readonly solution:
		| {
					readonly token: string | undefined;
					readonly cookie: string | undefined;
					readonly gRecaptchaResponse: string | undefined;
					readonly cookies: Readonly<Record<string, string>> | undefined;
					readonly userAgent: string | undefined;
				}
		| undefined;
}

class CapsolverVerdictError extends ResolverChallengeVerdictError {
	readonly phase: CapsolverOperationPhase;
	readonly errorCode: string | undefined;
	readonly errorDescription: string | undefined;

	constructor(options: {
		readonly phase: CapsolverOperationPhase;
		readonly errorCode?: string;
		readonly errorDescription?: string;
	}) {
		super(CAPSOLVER_VENDOR_ID, "solve_failed", options);
		this.phase = options.phase;
		this.errorCode = options.errorCode;
		this.errorDescription = options.errorDescription;
	}
}

function isJsonRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function containsSensitiveValue(value: unknown, sensitiveValues: readonly string[]): boolean {
	const secrets = sensitiveValues.filter((secret) => secret.length > 0);
	if (secrets.length === 0) return false;
	const seen = new Set<object>();

	const inspect = (candidate: unknown): boolean => {
		if (typeof candidate === "string") {
			return secrets.some((secret) => candidate.includes(secret));
		}
		if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function")) {
			return false;
		}
		if (seen.has(candidate)) return false;
		seen.add(candidate);

		try {
			for (const property of Reflect.ownKeys(candidate)) {
				if (typeof property === "string" && inspect(property)) return true;
				const descriptor = Object.getOwnPropertyDescriptor(candidate, property);
				if (!descriptor) return true;
				if ("value" in descriptor && inspect(descriptor.value)) return true;
				if (descriptor.get !== undefined || descriptor.set !== undefined) return true;
			}
		} catch {
			return true;
		}
		return false;
	};

	return inspect(value);
}

function safeCauseOptions(
	error: unknown,
	sensitiveValues: readonly string[],
): { readonly cause?: unknown } {
	return containsSensitiveValue(error, sensitiveValues) ? {} : { cause: error };
}

function sanitizedJsonParseCause(): SyntaxError {
	return new SyntaxError("Upstream response failed");
}

function raceWithAbort<T>(
	operation: () => Promise<T>,
	signal: AbortSignal,
	phase?: CapsolverOperationPhase,
	sensitiveValues: readonly string[] = [],
): Promise<T> {
	if (signal.aborted) return Promise.reject(abortReason(signal));

	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation().then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				if (phase === undefined) {
					reject(error);
					return;
				}
				reject(
					new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "transport_failure", {
						...safeCauseOptions(error, sensitiveValues),
						phase,
					}),
				);
			},
		);
	});
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await raceWithAbort(
			() =>
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, ms);
				}),
			signal,
		);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function responseErrorFields(payload: JsonRecord): CapsolverResponseErrorFields {
	return {
		errorId: typeof payload.errorId === "number" ? payload.errorId : undefined,
		errorCode: typeof payload.errorCode === "string" ? payload.errorCode : undefined,
		errorDescription:
			typeof payload.errorDescription === "string" ? payload.errorDescription : undefined,
	};
}

function parseCreateTaskResponse(payload: JsonRecord): CapsolverCreateTaskResponse {
	const taskId = payload.taskId;
	return {
		...responseErrorFields(payload),
		taskId: typeof taskId === "string" || typeof taskId === "number" ? taskId : undefined,
	};
}

function parsePollResultResponse(payload: JsonRecord): CapsolverPollResultResponse {
	const solution = isJsonRecord(payload.solution) ? payload.solution : undefined;
	const cookies = solution && isJsonRecord(solution.cookies)
		? Object.fromEntries(
				Object.entries(solution.cookies).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			)
		: undefined;
	return {
		...responseErrorFields(payload),
		status: typeof payload.status === "string" ? payload.status : undefined,
			solution: solution
			? {
					token: typeof solution.token === "string" ? solution.token : undefined,
					cookie: typeof solution.cookie === "string" ? solution.cookie : undefined,
					gRecaptchaResponse:
						typeof solution.gRecaptchaResponse === "string"
							? solution.gRecaptchaResponse
							: undefined,
					cookies,
					userAgent: typeof solution.userAgent === "string" ? solution.userAgent : undefined,
				  }
			: undefined,
	};
}

function proxyForCapsolver(
	proxyUrl: string,
): { readonly value: string; readonly sensitive: readonly string[] } | undefined {
	try {
		const url = new URL(proxyUrl);
		const protocol = url.protocol.slice(0, -1).toLowerCase();
		const scheme = protocol === "http" || protocol === "socks5" ? protocol : undefined;
		const port = Number(url.port || (scheme === "socks5" ? 1080 : 80));
		if (!scheme || !url.hostname || !Number.isInteger(port) || port <= 0 || port > 65_535) {
			return undefined;
		}
		const username = url.username ? decodeURIComponent(url.username) : "";
		const password = url.password ? decodeURIComponent(url.password) : "";
		if (username.includes(":") || password.includes(":")) return undefined;
		const value = `${scheme}:${url.hostname}:${port}${username || password ? `:${username}:${password}` : ""}`;
		return { value, sensitive: [proxyUrl, value, username, password].filter(Boolean) };
	} catch {
		return undefined;
	}
}

function isAllocationExhausted(payload: CapsolverResponseErrorFields): boolean {
	const code = payload.errorCode?.toLowerCase() ?? "";
	const description = payload.errorDescription?.toLowerCase() ?? "";
	return (
		code === "error_zero_balance" ||
		/(?:insufficient|zero|no|not enough)\s+(?:balance|funds|credit)/u.test(`${code} ${description}`)
	);
}

function isNegativeVerdict(payload: CapsolverResponseErrorFields): boolean {
	return payload.errorCode?.toLowerCase() === "error_captcha_unsolvable";
}

function safeVendorDetail(value: string, sensitiveValues: readonly string[]): string {
	const redacted = redactSensitiveText(value, sensitiveValues);
	return containsSensitiveValue(redacted, sensitiveValues) ? "[REDACTED]" : redacted;
}

function vendorErrorDetails(
	payload: CapsolverResponseErrorFields,
	sensitiveValues: readonly string[],
): { readonly errorCode?: string; readonly errorDescription?: string } {
	const errorCode = payload.errorCode?.trim();
	const errorDescription = payload.errorDescription?.trim();
	return {
		...(errorCode ? { errorCode: safeVendorDetail(errorCode, sensitiveValues) } : {}),
		...(errorDescription
			? { errorDescription: safeVendorDetail(payload.errorDescription ?? "", sensitiveValues) }
			: {}),
	};
}

function unavailableForPayload(
	payload: CapsolverResponseErrorFields,
	phase: CapsolverOperationPhase,
	sensitiveValues: readonly string[],
): ResolverVendorUnavailableError | ResolverChallengeVerdictError {
	const details = vendorErrorDetails(payload, sensitiveValues);
	if (isNegativeVerdict(payload)) {
		return new CapsolverVerdictError({ phase, ...details });
	}
	return new CapsolverUnavailableError(
		isAllocationExhausted(payload) ? "allocation_exhausted" : "transport_failure",
		{ phase, ...details },
	);
}

async function postJson<TResponse>(
	fetchImpl: typeof fetch,
	url: string,
	body: JsonRecord,
	signal: AbortSignal,
	phase: CapsolverOperationPhase,
	sensitiveValues: readonly string[],
	parseResponse: (payload: JsonRecord) => TResponse,
): Promise<{ readonly ok: boolean; readonly payload: TResponse }> {
	const response = await raceWithAbort(
		() =>
			fetchImpl(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal,
				redirect: "error",
			}),
		signal,
		phase,
		sensitiveValues,
	);

	let responseText: string;
	try {
		responseText = await raceWithAbort(() => response.text(), signal, phase, sensitiveValues);
	} catch (error) {
		if (error instanceof ResolverVendorUnavailableError) throw error;
		throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "transport_failure", {
			cause: error,
			phase,
		});
	}

	let payload: unknown;
	try {
		payload = JSON.parse(responseText);
	} catch {
		const contentType = response.headers.get("content-type");
		throw new CapsolverUnavailableError("transport_failure", {
			cause: sanitizedJsonParseCause(),
			phase,
			responseStatus: response.status,
			responseContentType: contentType
				? safeVendorDetail(contentType.slice(0, 128), sensitiveValues)
				: undefined,
			responseLength: responseText.length,
		});
	}
	if (!isJsonRecord(payload)) {
		throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "transport_failure", {
			phase,
		});
	}
	return { ok: response.ok, payload: parseResponse(payload) };
}

function endpoint(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/${path}`;
}

function spanErrorAttributes(
	error: unknown,
	phase: CapsolverOperationPhase,
): Record<string, unknown> | undefined {
	if (error instanceof ResolverVendorUnavailableError) {
		return {
			unavailability_reason: error.reason,
			transport_phase: error.phase,
			...(error instanceof CapsolverUnavailableError
				? {
						vendor_error_code: error.errorCode,
						vendor_error_description: error.errorDescription,
						response_status: error.responseStatus,
						response_content_type: error.responseContentType,
						response_length: error.responseLength,
					}
				: {}),
		};
	}
	if (error instanceof CapsolverVerdictError) {
		return {
			verdict_reason: error.reason,
			transport_phase: error.phase,
			vendor_error_code: error.errorCode,
			vendor_error_description: error.errorDescription,
		};
	}
	if (error instanceof CapsolverSolveTimeoutError) {
		return {
			unavailability_reason: "timeout",
			transport_phase: phase,
		};
	}
	return undefined;
}

export function createCapsolverResolverVendorAdapter(
	options: CapsolverResolverVendorOptions,
): CapsolverResolverVendorAdapter {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const baseUrl = options.baseUrl ?? DEFAULT_CAPSOLVER_BASE_URL;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = options.now ?? Date.now;
	const delay = options.delay ?? abortableDelay;

	return {
		id: CAPSOLVER_VENDOR_ID,

		supports(kind) {
			return resolverVendorSupports(CAPSOLVER_VENDOR_ID, kind);
		},

		async solve(challenge, identity, callerSignal, traceRecorder) {
			const apiKey = options.apiKey?.trim();
			if (!apiKey) {
				throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "missing_credentials", {
					phase: "create_task",
				});
			}
			if (!resolverVendorSupports(CAPSOLVER_VENDOR_ID, challenge.kind)) {
				throw new TypeError(`Capsolver resolver does not support ${challenge.kind}`);
			}
			const proxy = identity ? proxyForCapsolver(identity.proxyUrl) : undefined;
			if (challenge.kind === "aws_waf" && identity && !proxy) {
				throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "transport_failure", {
					phase: "create_task",
				});
			}
			if (challenge.kind === "cloudflare_interstitial" && !identity) {
				throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "missing_proxy_identity", {
					phase: "create_task",
				});
			}
			if (identity && !proxy) {
				throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "transport_failure", {
					phase: "create_task",
				});
			}
			const challengeFields = challenge as unknown as Record<string, unknown>;
			const sensitiveValues = [
				apiKey,
				challenge.pageUrl,
				...(typeof challengeFields.siteKey === "string" ? [challengeFields.siteKey] : []),
				...(typeof challengeFields.action === "string" ? [challengeFields.action] : []),
				...(typeof challengeFields.cdata === "string" ? [challengeFields.cdata] : []),
				...(typeof challengeFields.blockedHtml === "string" ? [challengeFields.blockedHtml] : []),
				...(typeof challengeFields.captchaScript === "string" ? [challengeFields.captchaScript] : []),
				...(typeof challengeFields.context === "string" ? [challengeFields.context] : []),
				...(typeof challengeFields.iv === "string" ? [challengeFields.iv] : []),
				...(proxy?.sensitive ?? []),
			];

			assertResolverHostAllowed(challenge.pageUrl, options.allowedHosts);
			callerSignal.throwIfAborted();

			const solveController = new AbortController();
			const onCallerAbort = () => solveController.abort(abortReason(callerSignal));
			callerSignal.addEventListener("abort", onCallerAbort, { once: true });
			const timeout = options.now
				? undefined
				: setTimeout(() => solveController.abort(new CapsolverSolveTimeoutError()), timeoutMs);
			const startedAt = now();
			let phase: CapsolverOperationPhase = "create_task";

			try {
				const createTask = async () => {
					const task =
						challenge.kind === "aws_waf"
							? {
									type: proxy ? "AntiAwsWafTask" : "AntiAwsWafTaskProxyLess",
									websiteURL: challenge.pageUrl,
									...(challenge.siteKey !== undefined ? { awsKey: challenge.siteKey } : {}),
									...(challenge.iv !== undefined ? { awsIv: challenge.iv } : {}),
									...(challenge.context !== undefined ? { awsContext: challenge.context } : {}),
									...(challenge.captchaScript !== undefined
										? { awsChallengeJS: challenge.captchaScript }
										: {}),
									...(proxy ? { proxy: proxy.value } : {}),
								}
							: challenge.kind === "turnstile"
								? {
										type: "AntiTurnstileTaskProxyLess",
										websiteURL: challenge.pageUrl,
										websiteKey: challenge.siteKey,
										...(challenge.action !== undefined || challenge.cdata !== undefined
											? {
													metadata: {
														...(challenge.action !== undefined ? { action: challenge.action } : {}),
														...(challenge.cdata !== undefined ? { cdata: challenge.cdata } : {}),
													},
												}
											: {}),
									}
							: challenge.kind === "recaptcha_v2"
								? {
										type: proxy ? "ReCaptchaV2Task" : "ReCaptchaV2TaskProxyLess",
										websiteURL: challenge.pageUrl,
										websiteKey: challenge.siteKey,
										...(proxy ? { proxy: proxy.value } : {}),
									}
							: challenge.kind === "recaptcha_v3"
								? {
										type: proxy ? "ReCaptchaV3Task" : "ReCaptchaV3TaskProxyLess",
										websiteURL: challenge.pageUrl,
										websiteKey: challenge.siteKey,
										pageAction: challenge.action,
										...(challenge.minScore !== undefined ? { minScore: challenge.minScore } : {}),
										...(proxy ? { proxy: proxy.value } : {}),
									}
							: challenge.kind === "hcaptcha"
								? {
										type: proxy ? "HCaptchaTask" : "HCaptchaTaskProxyLess",
										websiteURL: challenge.pageUrl,
										websiteKey: challenge.siteKey,
										...(proxy ? { proxy: proxy.value } : {}),
									}
							: challenge.kind === "cloudflare_interstitial"
								? {
										type: "AntiCloudflareTask",
										websiteURL: challenge.pageUrl,
										proxy: proxy?.value,
										...(identity?.userAgent ? { userAgent: identity.userAgent } : {}),
										...(challenge.kind === "cloudflare_interstitial" && challenge.blockedHtml !== undefined
											? { html: challenge.blockedHtml }
											: {}),
									}
								: (() => {
										throw new TypeError(`Capsolver resolver does not support ${challenge.kind}`);
									})();
					const createResult = await postJson(
						fetchImpl,
						endpoint(baseUrl, "createTask"),
						{ clientKey: apiKey, task },
						solveController.signal,
						phase,
						sensitiveValues,
						parseCreateTaskResponse,
					);
					const taskId = createResult.payload.taskId;
					if (!createResult.ok || createResult.payload.errorId !== 0 || taskId === undefined) {
						throw unavailableForPayload(createResult.payload, phase, sensitiveValues);
					}
					return taskId;
				};
				const taskId = traceRecorder
					? await traceRecorder.runSpan("resolver.vendor.create_task", createTask, {
							attributes: {
								vendor: CAPSOLVER_VENDOR_ID,
								challenge_kind: challenge.kind,
							},
							onError: (error) => spanErrorAttributes(error, "create_task"),
						})
					: await createTask();

				phase = "poll_result";
				const pollResult = async () => {
					while (true) {
						callerSignal.throwIfAborted();
						const remainingMs = timeoutMs - (now() - startedAt);
						if (remainingMs <= 0) throw new CapsolverSolveTimeoutError();
						await delay(Math.min(pollIntervalMs, remainingMs), solveController.signal);
						callerSignal.throwIfAborted();
						if (now() - startedAt >= timeoutMs) throw new CapsolverSolveTimeoutError();

						const result = await postJson(
							fetchImpl,
							endpoint(baseUrl, "getTaskResult"),
							{ clientKey: apiKey, taskId },
							solveController.signal,
							phase,
							sensitiveValues,
							parsePollResultResponse,
						);
						if (!result.ok || result.payload.errorId !== 0) {
							throw unavailableForPayload(result.payload, phase, sensitiveValues);
						}
						switch (result.payload.status) {
							case "idle":
							case "processing":
								continue;
							case "ready":
								break;
							default:
								throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "transport_failure", {
									phase,
								});
						}

						const solutionValue =
							challenge.kind === "aws_waf"
								? result.payload.solution?.cookie
								: result.payload.solution?.token ?? result.payload.solution?.gRecaptchaResponse;
						if (challenge.kind === "cloudflare_interstitial") {
							const cookies = result.payload.solution?.cookies;
							const clearance = cookies?.cf_clearance ?? solutionValue;
							if (!clearance?.trim()) {
								throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "transport_failure", {
									phase,
								});
							}
							return {
								form: "cookies" as const,
								cookies: cookies && Object.keys(cookies).length > 0 ? cookies : { cf_clearance: clearance },
								userAgent:
									result.payload.solution?.userAgent ??
									identity?.userAgent ??
									getStealthProfile(DEFAULT_STEALTH_PROFILE).userAgent,
							};
						}
						if (!solutionValue?.trim()) {
							throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "transport_failure", {
								phase,
							});
						}
						return challenge.kind === "aws_waf"
							? {
									form: "cookies" as const,
									cookies: { "aws-waf-token": solutionValue },
									userAgent:
										identity?.userAgent ?? getStealthProfile(DEFAULT_STEALTH_PROFILE).userAgent,
									sdkEstimatedExpires:
										(now() + SDK_ESTIMATED_COOKIE_TTL_MS_BY_CHALLENGE_KIND.aws_waf) / 1_000,
								}
							: { form: "token" as const, token: solutionValue };
					}
				};
				return traceRecorder
					? await traceRecorder.runSpan("resolver.vendor.poll_result", pollResult, {
							attributes: {
								vendor: CAPSOLVER_VENDOR_ID,
								challenge_kind: challenge.kind,
							},
							onError: (error) => spanErrorAttributes(error, "poll_result"),
						})
					: await pollResult();
			} catch (error) {
				if (callerSignal.aborted) throw abortReason(callerSignal);
				if (
					error instanceof CapsolverSolveTimeoutError ||
					solveController.signal.reason instanceof CapsolverSolveTimeoutError
				) {
					throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "timeout", {
						cause: error,
						phase,
					});
				}
				if (
					error instanceof ResolverVendorUnavailableError ||
					error instanceof ResolverChallengeVerdictError
				) {
					throw error;
				}
				throw new ResolverVendorUnavailableError(CAPSOLVER_VENDOR_ID, "transport_failure", {
					...safeCauseOptions(error, sensitiveValues),
					phase,
				});
			} finally {
				if (timeout !== undefined) clearTimeout(timeout);
				callerSignal.removeEventListener("abort", onCallerAbort);
			}
		},
	};
}
