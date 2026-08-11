import type {
	BrowserClient,
	BrowserCookie,
	BrowserPage,
	ChallengeSolution,
	ProviderChallenge,
} from "../../types.js";
import { isProviderError, ProviderError } from "../../errors.js";
import { type BrowserClientOptions, createBrowserClient } from "../browser.js";
import type { TraceRecorder } from "../trace.js";
import {
	type ResolverIdentity,
	type ResolverVendorAdapter,
	ResolverVendorUnavailableError,
} from "./types.js";

const BROWSER_VENDOR_ID = "browser" as const;
const DEFAULT_COOKIE_POLL_INTERVAL_MS = 100;

const SUCCESS_COOKIE_NAMES = {
	aws_waf: "aws-waf-token",
	cloudflare_interstitial: "cf_clearance",
} as const;

type SupportedBrowserChallengeKind = keyof typeof SUCCESS_COOKIE_NAMES;

type BrowserClientFactory = (options: BrowserClientOptions) => BrowserClient;

export interface BrowserResolverVendorOptions {
	readonly cdpUrl?: string;
	readonly timeoutMs: number;
	readonly pollIntervalMs?: number;
	readonly allowedHosts: readonly string[];
	readonly createClient?: BrowserClientFactory;
}

export type BrowserResolverSolution = Extract<ChallengeSolution, { readonly form: "cookies" }> & {
	/** Unix seconds from the cookie that proved the challenge cleared. */
	readonly expires?: number;
};

export interface BrowserResolverVendorAdapter extends ResolverVendorAdapter {
	readonly id: "browser";
	solve(
		challenge: ProviderChallenge,
		identity: ResolverIdentity | undefined,
		signal: AbortSignal,
		traceRecorder?: TraceRecorder,
	): Promise<BrowserResolverSolution>;
}

class BrowserSolveTimeoutError extends Error {
	constructor() {
		super("Browser resolver solve budget elapsed");
		this.name = "BrowserSolveTimeoutError";
	}
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function raceWithAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(abortReason(signal));
	}

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
				reject(error);
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

function isSupportedKind(kind: string): kind is SupportedBrowserChallengeKind {
	return Object.hasOwn(SUCCESS_COOKIE_NAMES, kind);
}

function normalizedHostname(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function assertChallengeHostAllowed(pageUrl: string, allowedHosts: readonly string[]): void {
	const challengeHost = normalizedHostname(new URL(pageUrl).hostname);
	const isAllowed = allowedHosts.some((host) => {
		const declaredHost = normalizedHostname(host);
		return declaredHost.length > 0 && !declaredHost.includes("*") && declaredHost === challengeHost;
	});
	if (isAllowed) return;

	throw new ProviderError(`Resolver challenge host "${challengeHost}" is not declared`, {
		code: "RESOLVER_HOST_NOT_ALLOWED",
		fix: "Add the exact challenge hostname to the provider's allowedHosts declaration.",
	});
}

function toCookieMap(cookies: readonly BrowserCookie[]): Readonly<Record<string, string>> {
	return Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value]));
}

async function solveInPage(
	page: BrowserPage,
	pageUrl: string,
	successCookieName: string,
	pollIntervalMs: number,
	signal: AbortSignal,
): Promise<BrowserResolverSolution> {
	await raceWithAbort(() => page.goto(pageUrl), signal);

	while (true) {
		const cookies = await raceWithAbort(() => page.cookies(), signal);
		const successCookie = cookies.find((cookie) => cookie.name === successCookieName);
		if (successCookie) {
			const userAgent = await raceWithAbort(
				() => page.evaluate<string>("navigator.userAgent"),
				signal,
			);
			return {
				form: "cookies",
				cookies: toCookieMap(cookies),
				userAgent,
				...(successCookie.expires === undefined ? {} : { expires: successCookie.expires }),
			};
		}

		await abortableDelay(pollIntervalMs, signal);
	}
}

function knownUnavailableReason(
	error: unknown,
): "allocation_exhausted" | "missing_credentials" | "transport_failure" | undefined {
	// Source-grounded mappings:
	// - apps/cdp-pool/src/index.ts: the three CDP pool acquire messages below.
	// - src/runtime/browser.ts: BROWSER_CDP_POOL_REQUIRED and the two WebSocket messages.
	// JsonRpcWebSocketClient drops the pool's JSON-RPC error code, so those pool errors
	// arrive here as plain Error instances and require exact, verified message substrings.
	if (isProviderError(error)) {
		return error.code === "BROWSER_CDP_POOL_REQUIRED" ? "missing_credentials" : undefined;
	}
	if (!(error instanceof Error)) return undefined;

	if (
		error.message.includes("CDP pool acquire queue is full") ||
		error.message.includes("CDP pool acquire timed out") ||
		error.message.includes("CDP pool is shutting down")
	) {
		return "allocation_exhausted";
	}

	if (
		error.message.includes("Unable to connect to WebSocket endpoint") ||
		error.message.includes("WebSocket closed")
	) {
		return "transport_failure";
	}

	return undefined;
}

async function closeBrowserClient(
	client: BrowserClient | undefined,
	challengeKind: ProviderChallenge["kind"],
	traceRecorder: TraceRecorder | undefined,
): Promise<void> {
	const close = client?.close;
	if (!close) return;

	const closeClient = () => close.call(client);
	if (!traceRecorder) {
		try {
			await closeClient();
		} catch {
			// Cleanup remains best-effort when the resolver has no trace recorder.
		}
		return;
	}

	await traceRecorder
		.runSpan("resolver.vendor.cleanup", closeClient, {
			attributes: {
				vendor: BROWSER_VENDOR_ID,
				challenge_kind: challengeKind,
				operation: "client.close",
			},
			onError(error) {
				return {
					error_message: error instanceof Error ? error.message : String(error),
					...(error instanceof Error && error.stack ? { error_stack: error.stack } : {}),
				};
			},
		})
		.catch(() => undefined);
}

export function createBrowserResolverVendorAdapter(
	options: BrowserResolverVendorOptions,
): BrowserResolverVendorAdapter {
	const createClient = options.createClient ?? createBrowserClient;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_COOKIE_POLL_INTERVAL_MS;

	return {
		id: BROWSER_VENDOR_ID,

		supports(kind) {
			return isSupportedKind(kind);
		},

		getIssuingIdentity(solution) {
			return solution.form === "cookies" ? { userAgent: solution.userAgent } : undefined;
		},

		async solve(challenge, identity, callerSignal, traceRecorder) {
			void identity;
			if (!options.cdpUrl?.trim()) {
				throw new ResolverVendorUnavailableError(BROWSER_VENDOR_ID, "missing_credentials");
			}
			if (!isSupportedKind(challenge.kind)) {
				throw new TypeError(`Browser resolver does not support ${challenge.kind}`);
			}
			assertChallengeHostAllowed(challenge.pageUrl, options.allowedHosts);
			const challengeKind = challenge.kind;
			callerSignal.throwIfAborted();

			const solveController = new AbortController();
			const onCallerAbort = () => solveController.abort(abortReason(callerSignal));
			callerSignal.addEventListener("abort", onCallerAbort, { once: true });
			const timeout = setTimeout(
				() => solveController.abort(new BrowserSolveTimeoutError()),
				options.timeoutMs,
			);

			let client: BrowserClient | undefined;
			let handlerEntered = false;
			try {
				client = createClient({
					allowedHosts: [...options.allowedHosts],
					cdpUrl: options.cdpUrl.trim(),
					requireCdpPool: true,
				});
				const contextOperation = client.withIsolatedContext(async (page) => {
					handlerEntered = true;
					return await solveInPage(
						page,
						challenge.pageUrl,
						SUCCESS_COOKIE_NAMES[challengeKind],
						pollIntervalMs,
						solveController.signal,
					);
				});

				try {
					return await raceWithAbort(() => contextOperation, solveController.signal);
				} catch (error) {
					if (solveController.signal.aborted) {
						if (handlerEntered) {
							await contextOperation;
							throw error;
						}
						await closeBrowserClient(client, challengeKind, traceRecorder);
						void contextOperation.catch(() => undefined);
					}
					throw error;
				}
			} catch (error) {
				if (callerSignal.aborted) throw abortReason(callerSignal);
				if (error instanceof BrowserSolveTimeoutError) {
					throw new ResolverVendorUnavailableError(BROWSER_VENDOR_ID, "timeout", {
						cause: error,
					});
				}
				if (error instanceof ResolverVendorUnavailableError) {
					throw error;
				}
				const reason = knownUnavailableReason(error);
				if (reason) {
					throw new ResolverVendorUnavailableError(BROWSER_VENDOR_ID, reason, { cause: error });
				}
				throw error;
			} finally {
				clearTimeout(timeout);
				callerSignal.removeEventListener("abort", onCallerAbort);
				await closeBrowserClient(client, challengeKind, traceRecorder);
			}
		},
	};
}
