import { isIP } from "node:net";

import type { ChallengeSolution, ProviderChallenge } from "../../types.js";
import { recordPaidResolverCreate } from "../resolver-usage.js";
import type { TraceRecorder } from "../trace.js";
import { assertResolverHostAllowed } from "./hosts.js";
import {
	ResolverChallengeVerdictError,
	type ResolverIdentity,
	type ResolverVendorAdapter,
	type ResolverVendorTransport,
	ResolverVendorUnavailableError,
} from "./types.js";

type ResolverPaidUsageContext = NonNullable<Parameters<ResolverVendorAdapter["solve"]>[5]>;

const HYPERSOLUTIONS_VENDOR_ID = "hypersolutions" as const;
const HYPER_SBSD_URL = "https://akm.hypersolutions.co/sbsd";
const HYPER_IP_URL = "https://ip.hypersolutions.co/ip";
const HYPER_TRANSPORT_HOSTS = ["akm.hypersolutions.co", "ip.hypersolutions.co"] as const;
const IP_RESPONSE_MAX_BYTES = 4_096;
const SCRIPT_MAX_BYTES = 1_000_000;
const HYPER_RESPONSE_MAX_BYTES = 1_000_000;
const PAYLOAD_RESPONSE_MAX_BYTES = 1_000_000;

type HyperPhase = "measure_ip" | "fetch_script" | "generate_payload" | "post_payload";

export interface HypersolutionsResolverVendorOptions {
	readonly apiKey?: string;
	readonly timeoutMs?: number;
	readonly allowedHosts: readonly string[];
}

export type AkamaiSbsdChallengeSolution = Extract<
	ChallengeSolution,
	{ readonly form: "cookies"; readonly kind: "akamai_sbsd" }
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

function responseHeader(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const target = name.toLowerCase();
	return Object.entries(headers).find(([header]) => header.toLowerCase() === target)?.[1];
}

function bodyByteLength(body: string): number {
	return new TextEncoder().encode(body).byteLength;
}

function assertBoundedBody(
	response: Awaited<ReturnType<ResolverVendorTransport["fetch"]>>,
	maxBytes: number,
	phase: HyperPhase,
): void {
	const declared = responseHeader(response.headers, "content-length")?.trim();
	if (declared && /^\d+$/u.test(declared) && BigInt(declared) > BigInt(maxBytes)) {
		throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "transport_failure", {
			phase,
		});
	}
	if (bodyByteLength(response.body) > maxBytes) {
		throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "transport_failure", {
			phase,
		});
	}
}

function requireSuccess(status: number, phase: HyperPhase): void {
	if (status >= 200 && status < 300) return;
	if (phase === "generate_payload") {
		throw new ResolverVendorUnavailableError(
			HYPERSOLUTIONS_VENDOR_ID,
			status === 401 || status === 403 ? "missing_credentials" : "transport_failure",
			{ phase },
		);
	}
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

function hyperRequestBody(input: {
	readonly index: number;
	readonly uuid: string;
	readonly stateCookieValue: string;
	readonly pageUrl: string;
	readonly userAgent: string;
	readonly script: string;
	readonly ip: string;
	readonly acceptLanguage: string;
}): string {
	return JSON.stringify({
		index: input.index,
		uuid: input.uuid,
		o: input.stateCookieValue,
		pageUrl: input.pageUrl,
		userAgent: input.userAgent,
		script: input.script,
		ip: input.ip,
		acceptLanguage: input.acceptLanguage,
	});
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
	const fetchUrl = new URL(parsed.pathname, parsed.origin);
	fetchUrl.searchParams.set("v", uuid);
	if (scriptToken) fetchUrl.searchParams.set("t", scriptToken);
	const postUrl = new URL(parsed.pathname, parsed.origin);
	const postToken = laterToken || scriptToken;
	if (postToken) postUrl.searchParams.set("t", postToken);
	return {
		fetchUrl: fetchUrl.toString(),
		postUrl: postUrl.toString(),
		uuid,
		indices: postToken ? [0] : [0, 1],
	};
}

function sessionHeader(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const target = name.toLowerCase();
	return Object.entries(headers)
		.find(([header]) => header.toLowerCase() === target)?.[1]
		?.trim();
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
		throw new ResolverChallengeVerdictError(HYPERSOLUTIONS_VENDOR_ID, "solve_failed");
	}
}

async function boundFetch(
	transport: ResolverVendorTransport,
	url: string,
	init: Parameters<ResolverVendorTransport["fetch"]>[1],
	phase: HyperPhase,
): Promise<Awaited<ReturnType<ResolverVendorTransport["fetch"]>>> {
	try {
		return await transport.fetch(url, init);
	} catch (cause) {
		if (
			cause instanceof ResolverVendorUnavailableError ||
			cause instanceof ResolverChallengeVerdictError
		) {
			throw cause;
		}
		throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "transport_failure", {
			cause,
			phase,
		});
	}
}

export function createHypersolutionsResolverVendorAdapter(
	options: HypersolutionsResolverVendorOptions,
): HypersolutionsResolverVendorAdapter {
	const apiKey = options.apiKey?.trim();
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
				? setTimeout(() => timeoutController.abort(), options.timeoutMs)
				: undefined;
			try {
				if (challenge.kind !== "akamai_sbsd") {
					throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "not_implemented");
				}
				if (!apiKey) {
					throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "missing_credentials");
				}
				if (!transport) {
					throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "missing_transport");
				}
				if (!transport.getCookie) {
					throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "missing_transport");
				}
				const sessionHeaders = transport.sessionHeaders;
				const userAgent = sessionHeaders ? sessionHeader(sessionHeaders, "user-agent") : undefined;
				const acceptLanguage = sessionHeaders
					? sessionHeader(sessionHeaders, "accept-language")
					: undefined;
				if (!sessionHeaders || !userAgent || !acceptLanguage) {
					throw new ResolverVendorUnavailableError(
						HYPERSOLUTIONS_VENDOR_ID,
						"missing_client_profile",
					);
				}
				assertChallengeInput(challenge, options.allowedHosts);
				const exchange = scriptExchangeUrls(challenge.scriptUrl, challenge.challengeToken);

				for (const url of [HYPER_IP_URL, HYPER_SBSD_URL]) {
					assertResolverHostAllowed(url, HYPER_TRANSPORT_HOSTS);
				}

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
				assertBoundedBody(ipResponse, IP_RESPONSE_MAX_BYTES, "measure_ip");
				requireSuccess(ipResponse.status, "measure_ip");
				const ip = parseObservedIp(ipResponse.body);
				if (!ip) {
					throw new ResolverVendorUnavailableError(HYPERSOLUTIONS_VENDOR_ID, "transport_failure", {
						phase: "measure_ip",
					});
				}

				const scriptResponse = await boundFetch(
					transport,
					exchange.fetchUrl,
					{
						method: "GET",
						headers: { ...sessionHeaders, Referer: challenge.pageUrl },
						signal: operationSignal,
						redirect: "manual",
						maxBodyBytes: SCRIPT_MAX_BYTES,
					},
					"fetch_script",
				);
				assertBoundedBody(scriptResponse, SCRIPT_MAX_BYTES, "fetch_script");
				requireSuccess(scriptResponse.status, "fetch_script");
				if (!scriptResponse.body) {
					throw new ResolverChallengeVerdictError(HYPERSOLUTIONS_VENDOR_ID, "solve_failed", {
						phase: "fetch_script",
					});
				}
				const originCookie = transport
					.getCookie(challenge.stateCookieName, challenge.pageUrl)
					?.trim();
				if (!originCookie) {
					throw new ResolverVendorUnavailableError(
						HYPERSOLUTIONS_VENDOR_ID,
						"missing_challenge_input",
						{ missingFields: [challenge.stateCookieName], phase: "fetch_script" },
					);
				}

				let expires: number | undefined;
				for (const [roundIndex, index] of exchange.indices.entries()) {
					const payload = await recordPaidResolverCreate({
						traceRecorder,
						vendor: HYPERSOLUTIONS_VENDOR_ID,
						kind: challenge.kind,
						signal: operationSignal,
						usage,
						create: async () => {
							const hyperResponse = await boundFetch(
								transport,
								HYPER_SBSD_URL,
								{
									method: "POST",
									headers: {
										accept: "application/json",
										"content-type": "application/json",
										"x-api-key": apiKey,
									},
									body: hyperRequestBody({
										index,
										uuid: exchange.uuid,
										stateCookieValue: originCookie,
										pageUrl: challenge.pageUrl,
										userAgent,
										script: scriptResponse.body,
										ip,
										acceptLanguage,
									}),
									signal: operationSignal,
									redirect: "manual",
									maxBodyBytes: HYPER_RESPONSE_MAX_BYTES,
								},
								"generate_payload",
							);
							assertBoundedBody(hyperResponse, HYPER_RESPONSE_MAX_BYTES, "generate_payload");
							requireSuccess(hyperResponse.status, "generate_payload");
							const payload = parsePayload(hyperResponse.body);
							if (!payload) {
								throw new ResolverVendorUnavailableError(
									HYPERSOLUTIONS_VENDOR_ID,
									"transport_failure",
									{ phase: "generate_payload", round: roundIndex + 1 },
								);
							}
							return payload;
						},
					});
					const payloadBody = JSON.stringify({ body: payload });
					if (bodyByteLength(payloadBody) > PAYLOAD_RESPONSE_MAX_BYTES) {
						throw new ResolverVendorUnavailableError(
							HYPERSOLUTIONS_VENDOR_ID,
							"transport_failure",
							{ phase: "post_payload", round: roundIndex + 1 },
						);
					}
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
							body: payloadBody,
							signal: operationSignal,
							redirect: "manual",
							maxBodyBytes: PAYLOAD_RESPONSE_MAX_BYTES,
						},
						"post_payload",
					);
					assertBoundedBody(postResponse, PAYLOAD_RESPONSE_MAX_BYTES, "post_payload");
					requireSuccess(postResponse.status, "post_payload");
					expires =
						postResponse.cookies.find((cookie) => cookie.name === challenge.stateCookieName)
							?.expires ?? expires;
				}

				const updatedCookie = transport
					.getCookie(challenge.stateCookieName, challenge.pageUrl)
					?.trim();
				if (!updatedCookie || updatedCookie === originCookie) {
					throw new ResolverChallengeVerdictError(HYPERSOLUTIONS_VENDOR_ID, "solve_failed", {
						phase: "post_payload",
					});
				}
				return {
					form: "cookies",
					kind: "akamai_sbsd",
					outcome: "payload_accepted_cookies_updated",
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
