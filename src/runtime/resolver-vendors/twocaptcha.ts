import type { ChallengeSolution, ProviderChallenge } from "../../types.js";
import type { TraceRecorder } from "../trace.js";
import { assertResolverHostAllowed } from "./hosts.js";
import {
	type ResolverIdentity,
	type ResolverVendorAdapter,
	ResolverChallengeVerdictError,
	ResolverVendorUnavailableError,
	resolverVendorSupports,
} from "./types.js";

const TWOCAPTCHA_VENDOR_ID = "2captcha" as const;
const DEFAULT_TWOCAPTCHA_BASE_URL = "https://api.2captcha.com";
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 180_000;

type Delay = (ms: number, signal: AbortSignal) => Promise<void>;
type TwoCaptchaOperationPhase = "create_task" | "poll_result";

export interface TwoCaptchaResolverVendorOptions {
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

export interface TwoCaptchaResolverVendorAdapter extends ResolverVendorAdapter {
	readonly id: "2captcha";
	solve(
		challenge: ProviderChallenge,
		identity: ResolverIdentity | undefined,
		signal: AbortSignal,
		traceRecorder?: TraceRecorder,
	): Promise<Extract<ChallengeSolution, { readonly form: "token" }>>;
}

class TwoCaptchaSolveTimeoutError extends Error {
	constructor() {
		super("2captcha resolver solve budget elapsed");
		this.name = "TwoCaptchaSolveTimeoutError";
	}
}

type JsonRecord = Record<string, unknown>;

type ProxyConfiguration = {
	readonly proxyType: "http" | "socks4" | "socks5";
	readonly proxyAddress: string;
	readonly proxyPort: number;
	readonly proxyLogin?: string;
	readonly proxyPassword?: string;
};

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
		if (
			candidate === null ||
			(typeof candidate !== "object" && typeof candidate !== "function")
		) {
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

function raceWithAbort<T>(
	operation: () => Promise<T>,
	signal: AbortSignal,
	phase?: TwoCaptchaOperationPhase,
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
					new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "transport_failure", {
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

function parseProxyConfiguration(proxyUrl: string): ProxyConfiguration | undefined {
	try {
		const url = new URL(proxyUrl);
		const protocol = url.protocol.slice(0, -1).toLowerCase();
		const proxyType =
			protocol === "socks4" || protocol === "socks5"
				? protocol
				: protocol === "http" || protocol === "https"
					? "http"
					: undefined;
		const defaultPort = proxyType === "http" ? 80 : 1080;
		const proxyPort = Number(url.port || defaultPort);
		if (!proxyType || !url.hostname || !Number.isInteger(proxyPort) || proxyPort <= 0) {
			return undefined;
		}
		const proxyLogin = url.username ? decodeURIComponent(url.username) : undefined;
		const proxyPassword = url.password ? decodeURIComponent(url.password) : undefined;
		return {
			proxyType,
			proxyAddress: url.hostname,
			proxyPort,
			...(proxyLogin ? { proxyLogin } : {}),
			...(proxyPassword ? { proxyPassword } : {}),
		};
	} catch {
		return undefined;
	}
}

function errorText(payload: JsonRecord, key: "errorCode" | "errorDescription"): string {
	const value = payload[key];
	return typeof value === "string" ? value : "";
}

function isAllocationExhausted(payload: JsonRecord): boolean {
	const code = errorText(payload, "errorCode").toLowerCase();
	const description = errorText(payload, "errorDescription").toLowerCase();
	return (
		code === "error_zero_balance" ||
		/(?:insufficient|zero|no|not enough)\s+(?:balance|funds|credit)/u.test(`${code} ${description}`)
	);
}

function isNegativeVerdict(payload: JsonRecord): boolean {
	return errorText(payload, "errorCode").toLowerCase() === "error_captcha_unsolvable";
}

function unavailableForPayload(
	payload: JsonRecord,
	phase: TwoCaptchaOperationPhase,
): ResolverVendorUnavailableError | ResolverChallengeVerdictError {
	if (isNegativeVerdict(payload)) {
		return new ResolverChallengeVerdictError(TWOCAPTCHA_VENDOR_ID, "solve_failed");
	}
	return new ResolverVendorUnavailableError(
		TWOCAPTCHA_VENDOR_ID,
		isAllocationExhausted(payload) ? "allocation_exhausted" : "transport_failure",
		{ phase },
	);
}

async function postJson(
	fetchImpl: typeof fetch,
	url: string,
	body: JsonRecord,
	signal: AbortSignal,
	phase: TwoCaptchaOperationPhase,
	sensitiveValues: readonly string[],
): Promise<{ readonly ok: boolean; readonly payload: JsonRecord }> {
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
		responseText = await raceWithAbort(() => response.text(), signal, phase);
	} catch (error) {
		if (error instanceof ResolverVendorUnavailableError) throw error;
		throw new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "transport_failure", {
			cause: error,
			phase,
		});
	}

	let payload: unknown;
	try {
		payload = JSON.parse(responseText);
	} catch {
		// JSON parse errors may contain response-body excerpts, so do not retain them as causes.
		throw new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "transport_failure", {
			phase,
		});
	}
	if (!isJsonRecord(payload)) {
		throw new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "transport_failure", {
			phase,
		});
	}
	return { ok: response.ok, payload };
}

function taskIdFrom(payload: JsonRecord): string | number | undefined {
	const taskId = payload.taskId;
	return typeof taskId === "string" || typeof taskId === "number" ? taskId : undefined;
}

function tokenFrom(payload: JsonRecord, challenge: ProviderChallenge): string | undefined {
	const solution = payload.solution;
	if (!isJsonRecord(solution)) return undefined;
	if (challenge.kind === "aws_waf") {
		return typeof solution.existing_token === "string" ? solution.existing_token : undefined;
	}
	if (typeof solution.gRecaptchaResponse === "string") return solution.gRecaptchaResponse;
	return typeof solution.token === "string" ? solution.token : undefined;
}

function endpoint(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/+$/u, "")}/${path}`;
}

function spanErrorAttributes(
	error: unknown,
	phase: TwoCaptchaOperationPhase,
): Record<string, unknown> | undefined {
	if (error instanceof ResolverVendorUnavailableError) {
		return {
			unavailability_reason: error.reason,
			transport_phase: error.phase,
		};
	}
	// The solve budget raises TwoCaptchaSolveTimeoutError inside the spanned closure and
	// the outer catch converts it only after the span has been finalized, so the span has
	// to recognize it here or slow solves lose exactly the attribution these spans add.
	if (error instanceof TwoCaptchaSolveTimeoutError) {
		return {
			unavailability_reason: "timeout",
			transport_phase: phase,
		};
	}
	return undefined;
}

export function createTwoCaptchaResolverVendorAdapter(
	options: TwoCaptchaResolverVendorOptions,
): TwoCaptchaResolverVendorAdapter {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const baseUrl = options.baseUrl ?? DEFAULT_TWOCAPTCHA_BASE_URL;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = options.now ?? Date.now;
	const delay = options.delay ?? abortableDelay;

	return {
		id: TWOCAPTCHA_VENDOR_ID,

		supports(kind) {
			return resolverVendorSupports(TWOCAPTCHA_VENDOR_ID, kind);
		},

		async solve(challenge, identity, callerSignal, traceRecorder) {
			const apiKey = options.apiKey?.trim();
			if (!apiKey) {
				throw new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "missing_credentials", {
					phase: "create_task",
				});
			}
			if (!resolverVendorSupports(TWOCAPTCHA_VENDOR_ID, challenge.kind)) {
				throw new TypeError(`2captcha resolver does not support ${challenge.kind}`);
			}
			if (challenge.kind === "aws_waf") {
				const missingFields = [
					...(challenge.siteKey?.trim() ? [] : ["siteKey"]),
					...(challenge.captchaScript?.trim() ? [] : ["captchaScript"]),
					...(challenge.context?.trim() ? [] : ["context"]),
					...(challenge.iv?.trim() ? [] : ["iv"]),
				];
				if (missingFields.length > 0) {
					throw new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "missing_challenge_input", {
						missingFields,
						phase: "create_task",
					});
				}
			}
			if (challenge.kind === "recaptcha_v3" && challenge.minScore === undefined) {
				throw new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "missing_challenge_input", {
					missingFields: ["minScore"],
					phase: "create_task",
				});
			}

			assertResolverHostAllowed(challenge.pageUrl, options.allowedHosts);
			callerSignal.throwIfAborted();

			const proxy = identity ? parseProxyConfiguration(identity.proxyUrl) : undefined;
			if (identity && !proxy) {
				throw new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "transport_failure", {
					phase: "create_task",
				});
			}

			const solveController = new AbortController();
			const onCallerAbort = () => solveController.abort(abortReason(callerSignal));
			callerSignal.addEventListener("abort", onCallerAbort, { once: true });
			const timeout = options.now
				? undefined
				: setTimeout(() => solveController.abort(new TwoCaptchaSolveTimeoutError()), timeoutMs);
			const startedAt = now();
			let phase: TwoCaptchaOperationPhase = "create_task";

			try {
				const createTask = async () => {
					const task =
						challenge.kind === "aws_waf"
							? {
									type: proxy ? "AmazonTask" : "AmazonTaskProxyless",
									websiteURL: challenge.pageUrl,
									websiteKey: challenge.siteKey,
									captchaScript: challenge.captchaScript,
									context: challenge.context,
									iv: challenge.iv,
									...(identity ? { userAgent: identity.userAgent } : {}),
									...(proxy ?? {}),
								}
						: challenge.kind === "recaptcha_v2"
							? {
								type: proxy ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyless",
									websiteURL: challenge.pageUrl,
									websiteKey: challenge.siteKey,
									isInvisible: false,
									...(identity ? { userAgent: identity.userAgent } : {}),
								...(proxy ?? {}),
							}
						: challenge.kind === "recaptcha_v3"
							? {
									type: "RecaptchaV3TaskProxyless",
									websiteURL: challenge.pageUrl,
									websiteKey: challenge.siteKey,
									minScore: challenge.minScore,
									pageAction: challenge.action,
									...(identity ? { userAgent: identity.userAgent } : {}),
								}
						: challenge.kind === "hcaptcha"
							? {
									type: proxy ? "HCaptchaTask" : "HCaptchaTaskProxyless",
									websiteURL: challenge.pageUrl,
									websiteKey: challenge.siteKey,
									...(identity ? { userAgent: identity.userAgent } : {}),
									...(proxy ?? {}),
								}
						: challenge.kind === "turnstile"
							? {
									type: proxy ? "TurnstileTask" : "TurnstileTaskProxyless",
									websiteURL: challenge.pageUrl,
									websiteKey: challenge.siteKey,
									...(challenge.action !== undefined ? { action: challenge.action } : {}),
									...(challenge.cdata !== undefined ? { data: challenge.cdata } : {}),
									...(identity ? { userAgent: identity.userAgent } : {}),
									...(proxy ?? {}),
								}
							: // `resolverVendorSupports` above already rejected every kind this
								// adapter does not build a task for, so this branch is unreachable.
								(() => {
									throw new TypeError(
										`2captcha resolver does not support ${challenge.kind}`,
									);
								})();
					const createResult = await postJson(
						fetchImpl,
						endpoint(baseUrl, "createTask"),
						{ clientKey: apiKey, task },
						solveController.signal,
						phase,
						[apiKey],
					);
					const taskId = taskIdFrom(createResult.payload);
					if (!createResult.ok || createResult.payload.errorId !== 0 || taskId === undefined) {
						throw unavailableForPayload(createResult.payload, phase);
					}
					return taskId;
				};
				const taskId = traceRecorder
					? await traceRecorder.runSpan("resolver.vendor.create_task", createTask, {
							attributes: {
								vendor: TWOCAPTCHA_VENDOR_ID,
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
						if (remainingMs <= 0) throw new TwoCaptchaSolveTimeoutError();
						await delay(Math.min(pollIntervalMs, remainingMs), solveController.signal);
						callerSignal.throwIfAborted();
						if (now() - startedAt >= timeoutMs) throw new TwoCaptchaSolveTimeoutError();

						const pollResult = await postJson(
							fetchImpl,
							endpoint(baseUrl, "getTaskResult"),
							{ clientKey: apiKey, taskId },
							solveController.signal,
							phase,
							[apiKey],
						);
						if (!pollResult.ok || pollResult.payload.errorId !== 0) {
							throw unavailableForPayload(pollResult.payload, phase);
						}
						if (pollResult.payload.status === "processing") continue;
						if (pollResult.payload.status !== "ready") {
							throw new ResolverVendorUnavailableError(
								TWOCAPTCHA_VENDOR_ID,
								"transport_failure",
								{ phase },
							);
						}

						const token = tokenFrom(pollResult.payload, challenge);
						if (!token?.trim()) {
							throw new ResolverVendorUnavailableError(
								TWOCAPTCHA_VENDOR_ID,
								"transport_failure",
								{ phase },
							);
						}
						// AWS WAF remains a token solution here, so resolver cookie caching does not apply.
						return { form: "token" as const, token };
					}
				};
				return traceRecorder
					? await traceRecorder.runSpan("resolver.vendor.poll_result", pollResult, {
							attributes: {
								vendor: TWOCAPTCHA_VENDOR_ID,
								challenge_kind: challenge.kind,
							},
							onError: (error) => spanErrorAttributes(error, "poll_result"),
						})
					: await pollResult();
			} catch (error) {
				if (callerSignal.aborted) throw abortReason(callerSignal);
				if (
					error instanceof TwoCaptchaSolveTimeoutError ||
					solveController.signal.reason instanceof TwoCaptchaSolveTimeoutError
				) {
					throw new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "timeout", {
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
				throw new ResolverVendorUnavailableError(TWOCAPTCHA_VENDOR_ID, "transport_failure", {
					...safeCauseOptions(error, [apiKey]),
					phase,
				});
			} finally {
				if (timeout !== undefined) clearTimeout(timeout);
				callerSignal.removeEventListener("abort", onCallerAbort);
			}
		},
	};
}
