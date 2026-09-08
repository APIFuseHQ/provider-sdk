import { isIP } from "node:net";

import type { ChallengeSolution, ProviderChallenge } from "../../types.js";
import { recordPaidResolverCreate } from "../resolver-usage.js";
import type { TraceRecorder } from "../trace.js";
import { assertResolverHostAllowed, RESOLVER_VENDOR_TRANSPORT_HOSTS } from "./hosts.js";
import {
	ResolverChallengeVerdictError,
	type ResolverIdentity,
	type ResolverPaidUsageContext,
	type ResolverVendorAdapter,
	type ResolverVendorTransport,
	ResolverVendorUnavailableError,
} from "./types.js";

const HYPERSOLUTIONS_VENDOR_ID = "hypersolutions" as const;
const HYPER_SBSD_URL = "https://akm.hypersolutions.co/sbsd";
const HYPER_IP_URL = "https://ip.hypersolutions.co/ip";
/**
 * Only the observed-IP reflector rides the bound transport: Hyper must see the
 * egress address the upstream will see. The payload-generation POST carries no
 * identity and goes direct, as in the measured zozotown source.
 */
const HYPER_TRANSPORT_HOSTS = RESOLVER_VENDOR_TRANSPORT_HOSTS.hypersolutions;
const IP_RESPONSE_MAX_BYTES = 4_096;
/** Measured bound shared by the script, the Hyper envelope, and the payload submission. */
const BODY_MAX_BYTES = 1_000_000;

type HyperPhase = "measure_ip" | "fetch_script" | "generate_payload" | "post_payload";

export interface HypersolutionsResolverVendorOptions {
	readonly apiKey?: string;
	readonly timeoutMs?: number;
	readonly allowedHosts: readonly string[];
	/** Direct egress used only for the Hyper payload-generation POST. */
	readonly fetchImpl?: typeof fetch;
}

export type AkamaiSbsdChallengeSolution = Extract<
	ChallengeSolution,
	{ readonly form: "cookie_state" }
>;

export interface HypersolutionsResolverVendorAdapter extends ResolverVendorAdapter {
	readonly id: "hypersolutions";
	readonly requiresTransport: true;
	readonly transportAllowedHosts: typeof HYPER_TRANSPORT_HOSTS;
	solve(
		challenge: ProviderChallenge,
		identity: ResolverIdentity | undefined,
		signal: AbortSignal,
		traceRecorder?: TraceRecorder,
		transport?: ResolverVendorTransport,
		usage?: ResolverPaidUsageContext,
	): Promise<AkamaiSbsdChallengeSolution>;
}

type TransportResponse = Awaited<ReturnType<ResolverVendorTransport["fetch"]>>;

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
	const target = name.toLowerCase();
	return Object.entries(headers)
		.find(([header]) => header.toLowerCase() === target)?.[1]
		?.trim();
}

function declaredLengthExceeds(declared: string | undefined, maxBytes: number): boolean {
	return declared !== undefined && /^\d+$/u.test(declared) && BigInt(declared) > BigInt(maxBytes);
}

function transportFailure(phase: HyperPhase, cause?: unknown): ResolverVendorUnavailableError {
	return new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "transport_failure", {
		phase,
		...(cause === undefined ? {} : { cause }),
	});
}

function assertBoundedBody(response: TransportResponse, maxBytes: number, phase: HyperPhase): void {
	if (
		declaredLengthExceeds(headerValue(response.headers, "content-length"), maxBytes) ||
		new TextEncoder().encode(response.body).byteLength > maxBytes
	) {
		throw transportFailure(phase);
	}
}

function requireSuccess(status: number, phase: HyperPhase): void {
	if (status >= 200 && status < 300) return;
	if (phase === "measure_ip" || phase === "generate_payload") {
		// Hyper's own service: a rejected key is a credential fault, anything else is transport.
		throw new ResolverVendorUnavailableError(
			HYPERSOLUTIONS_VENDOR_ID,
			status === 401 || status === 403 ? "missing_credentials" : "transport_failure",
			{ phase },
		);
	}
	// The upstream refused the script GET or the payload POST: that is the challenge verdict.
	throw new ResolverChallengeVerdictError(HYPERSOLUTIONS_VENDOR_ID, "solve_failed", { phase });
}

function parseObservedIp(body: string): string | undefined {
	let value: unknown = body.trim();
	try {
		value = JSON.parse(body);
	} catch {
		// Hyper's reflector has returned both JSON and plain text in measured clients.
	}
	if (value && typeof value === "object" && !Array.isArray(value) && "ip" in value) {
		value = value.ip;
	}
	if (typeof value !== "string") return undefined;
	const candidate = value.trim();
	return isIP(candidate) ? candidate : undefined;
}

function parsePayload(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("payload" in parsed)) {
			return undefined;
		}
		return typeof parsed.payload === "string" && parsed.payload.length > 0
			? parsed.payload
			: undefined;
	} catch {
		return undefined;
	}
}

function scriptExchangeUrls(
	scriptUrl: string,
	laterChallengeToken: string | undefined,
): {
	readonly fetchUrl: string;
	readonly postUrl: string;
	readonly uuid: string;
	readonly indices: readonly number[];
} {
	// `?v=&t=` is the hard SBSD variant and `?v=` is passive SBSD. A no-query
	// Akamai script is a sensor-family artifact and stays outside this adapter.
	const parsed = new URL(scriptUrl);
	const uuid = parsed.searchParams.get("v")?.trim();
	if (!uuid) {
		throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "missing_challenge_input", {
			missingFields: ["scriptUrl"],
			phase: "fetch_script",
		});
	}
	const scriptToken = parsed.searchParams.get("t")?.trim();
	const laterToken = laterChallengeToken?.trim();
	if (scriptToken && laterToken) {
		throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "missing_challenge_input", {
			missingFields: ["challengeToken"],
			phase: "fetch_script",
		});
	}
	// Clone the validated URL and only replace its query: reparsing `pathname`
	// against `origin` would read a `//host/...` pathname as a network-path
	// reference and swap the host that assertChallengeInput just admitted.
	const fetchUrl = new URL(parsed);
	fetchUrl.search = "";
	fetchUrl.hash = "";
	fetchUrl.searchParams.set("v", uuid);
	if (scriptToken) fetchUrl.searchParams.set("t", scriptToken);
	const postUrl = new URL(fetchUrl);
	postUrl.search = "";
	const postToken = laterToken || scriptToken;
	if (postToken) postUrl.searchParams.set("t", postToken);
	return {
		fetchUrl: fetchUrl.toString(),
		postUrl: postUrl.toString(),
		uuid,
		indices: postToken ? [0] : [0, 1],
	};
}

function assertChallengeInput(
	challenge: Extract<ProviderChallenge, { readonly kind: "akamai_sbsd" }>,
	allowedHosts: readonly string[],
): void {
	const missingFields = [
		...(challenge.pageUrl.trim() ? [] : ["pageUrl"]),
		...(challenge.scriptUrl.trim() ? [] : ["scriptUrl"]),
		...(challenge.stateCookieName === "sbsd_o" || challenge.stateCookieName === "bm_so"
			? []
			: ["stateCookieName"]),
		...(challenge.challengeToken === undefined || challenge.challengeToken.trim()
			? []
			: ["challengeToken"]),
	];
	if (missingFields.length > 0) {
		throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "missing_challenge_input", {
			missingFields,
		});
	}
	assertResolverHostAllowed(challenge.pageUrl, allowedHosts);
	assertResolverHostAllowed(challenge.scriptUrl, allowedHosts);
	if (new URL(challenge.pageUrl).origin !== new URL(challenge.scriptUrl).origin) {
		// The state cookie is read for pageUrl and posted to scriptUrl; they must share an origin.
		throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "missing_challenge_input", {
			missingFields: ["scriptUrl"],
		});
	}
}

async function boundFetch(
	transport: ResolverVendorTransport,
	url: string,
	init: Parameters<ResolverVendorTransport["fetch"]>[1],
	phase: HyperPhase,
): Promise<TransportResponse> {
	try {
		return await transport.fetch(url, init);
	} catch (cause) {
		if (
			cause instanceof ResolverVendorUnavailableError ||
			cause instanceof ResolverChallengeVerdictError
		) {
			throw cause;
		}
		// An abort is the caller's (or the adapter timeout's) verdict, not a transport fault.
		if (init.signal.aborted) throw init.signal.reason ?? cause;
		throw transportFailure(phase, cause);
	}
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | undefined> {
	if (declaredLengthExceeds(response.headers.get("content-length")?.trim(), maxBytes)) {
		await response.body?.cancel();
		return undefined;
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel();
			return undefined;
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

async function generatePayload(
	fetchImpl: typeof fetch,
	apiKey: string,
	body: string,
	signal: AbortSignal,
): Promise<{ readonly status: number; readonly body: string | undefined }> {
	try {
		const response = await fetchImpl(HYPER_SBSD_URL, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"x-api-key": apiKey,
			},
			body,
			signal,
			redirect: "error",
		});
		// A body that fails mid-read is as much a transport fault as a refused connection.
		return { status: response.status, body: await readBoundedText(response, BODY_MAX_BYTES) };
	} catch (cause) {
		if (signal.aborted) throw signal.reason ?? cause;
		throw transportFailure("generate_payload", cause);
	}
}

export function createHypersolutionsResolverVendorAdapter(
	options: HypersolutionsResolverVendorOptions,
): HypersolutionsResolverVendorAdapter {
	const apiKey = options.apiKey?.trim();
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	return {
		id: HYPERSOLUTIONS_VENDOR_ID,
		requiresTransport: true,
		transportAllowedHosts: HYPER_TRANSPORT_HOSTS,
		supports: (kind) => kind === "akamai_sbsd",
		async solve(challenge, _identity, signal, traceRecorder, transport, usage) {
			const timeoutController = new AbortController();
			const operationSignal = options.timeoutMs
				? AbortSignal.any([signal, timeoutController.signal])
				: signal;
			const timeout = options.timeoutMs
				? setTimeout(
						// A named reason lets the usage span record `timeout`, not a caller abort.
						() => timeoutController.abort(new DOMException("Hyper solve timed out", "TimeoutError")),
						options.timeoutMs,
					)
				: undefined;
			const runPhase = <T>(phase: HyperPhase, fn: () => Promise<T>): Promise<T> =>
				traceRecorder ? traceRecorder.runSpan(`resolver.vendor.${phase}`, fn) : fn();
			try {
				if (challenge.kind !== "akamai_sbsd") {
					throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "not_implemented");
				}
				if (!apiKey) {
					throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "missing_credentials");
				}
				if (!transport?.getCookie) {
					throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "missing_transport");
				}
				const sessionHeaders = transport.sessionHeaders;
				const userAgent = sessionHeaders ? headerValue(sessionHeaders, "user-agent") : undefined;
				const acceptLanguage = sessionHeaders
					? headerValue(sessionHeaders, "accept-language")
					: undefined;
				if (!sessionHeaders || !userAgent || !acceptLanguage) {
					throw new ResolverVendorUnavailableError(
						HYPERSOLUTIONS_VENDOR_ID,
						"missing_client_profile",
					);
				}
				assertChallengeInput(challenge, options.allowedHosts);
				const exchange = scriptExchangeUrls(challenge.scriptUrl, challenge.challengeToken);

				// Hyper documents /ip as an authenticated service request but does not
				// publish an explicit exclusion from request quota. Meter conservatively.
				const ip = await recordPaidResolverCreate({
					traceRecorder,
					vendor: HYPERSOLUTIONS_VENDOR_ID,
					kind: challenge.kind,
					endpoint: "hyper:ip",
					signal: operationSignal,
					usage,
					create: () =>
						runPhase("measure_ip", async () => {
					const ipResponse = await boundFetch(
						transport,
						HYPER_IP_URL,
						{
							method: "GET",
							headers: {
								accept: "application/json, text/plain;q=0.9",
								"x-api-key": apiKey,
							},
							signal: operationSignal,
							redirect: "manual",
							maxBodyBytes: IP_RESPONSE_MAX_BYTES,
						},
						"measure_ip",
					);
					requireSuccess(ipResponse.status, "measure_ip");
					assertBoundedBody(ipResponse, IP_RESPONSE_MAX_BYTES, "measure_ip");
					const observedIp = parseObservedIp(ipResponse.body);
					if (!observedIp) throw transportFailure("measure_ip");
					return observedIp;
						}),
				});

				const scriptResponse = await runPhase("fetch_script", async () => {
					const scriptResponse = await boundFetch(
						transport,
						exchange.fetchUrl,
						{
							method: "GET",
							headers: { ...sessionHeaders, Referer: challenge.pageUrl },
							signal: operationSignal,
							redirect: "manual",
							maxBodyBytes: BODY_MAX_BYTES,
						},
						"fetch_script",
					);
					requireSuccess(scriptResponse.status, "fetch_script");
					assertBoundedBody(scriptResponse, BODY_MAX_BYTES, "fetch_script");
					if (!scriptResponse.body) {
						throw new ResolverChallengeVerdictError(HYPERSOLUTIONS_VENDOR_ID, "solve_failed", {
							phase: "fetch_script",
						});
					}
					return scriptResponse;
				});
				const stateCookie = transport
					.getCookie(challenge.stateCookieName, challenge.pageUrl)
					?.trim();
				if (!stateCookie) {
					throw new ResolverVendorUnavailableError(
						HYPERSOLUTIONS_VENDOR_ID,
						"missing_challenge_input",
						{ missingFields: [challenge.stateCookieName], phase: "fetch_script" },
					);
				}

				let expires: number | undefined;
				for (const [roundIndex, index] of exchange.indices.entries()) {
					const round = roundIndex + 1;
					const payload = await recordPaidResolverCreate({
						traceRecorder,
						vendor: HYPERSOLUTIONS_VENDOR_ID,
						kind: challenge.kind,
						endpoint: "hyper:sbsd_create",
						round,
						signal: operationSignal,
						usage,
						create: () =>
							runPhase("generate_payload", async () => {
						const hyperResponse = await generatePayload(
							fetchImpl,
							apiKey,
							JSON.stringify({
								index,
								uuid: exchange.uuid,
								o: stateCookie,
								pageUrl: challenge.pageUrl,
								userAgent,
								script: scriptResponse.body,
								ip,
								acceptLanguage,
							}),
							operationSignal,
						);
						requireSuccess(hyperResponse.status, "generate_payload");
						const generated =
							hyperResponse.body === undefined ? undefined : parsePayload(hyperResponse.body);
						if (!generated) {
							throw new ResolverVendorUnavailableError(
								HYPERSOLUTIONS_VENDOR_ID,
								"transport_failure",
								{ phase: "generate_payload", round },
							);
						}
						return generated;
							}),
					});
					const postResponse = await runPhase("post_payload", async () => {
						const postResponse = await boundFetch(
							transport,
							exchange.postUrl,
							{
								method: "POST",
								headers: {
									...sessionHeaders,
									"content-type": "application/json",
									Referer: challenge.pageUrl,
								},
								body: JSON.stringify({ body: payload }),
								signal: operationSignal,
								redirect: "manual",
								maxBodyBytes: BODY_MAX_BYTES,
							},
							"post_payload",
						);
						requireSuccess(postResponse.status, "post_payload");
						assertBoundedBody(postResponse, BODY_MAX_BYTES, "post_payload");
						return postResponse;
					});
					expires =
						postResponse.cookies.find((cookie) => cookie.name === challenge.stateCookieName)
							?.expires ?? expires;
				}

				// A 2xx payload POST is not proof of a solve and the state cookie is not
				// required to rotate (measured zozotown source and Hyper's docs both verify
				// only through the next protected GET, which is Phase 2).
				return {
					form: "cookie_state",
					kind: "akamai_sbsd",
					outcome: "payload_accepted",
					verified: false,
					stateCookieName: challenge.stateCookieName,
					...(expires === undefined ? {} : { expires }),
				};
			} catch (error) {
				if (timeoutController.signal.aborted && !signal.aborted) {
					throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "timeout");
				}
				throw error;
			} finally {
				if (timeout !== undefined) clearTimeout(timeout);
			}
		},
	};
}
