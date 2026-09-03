import { describe, expect, it, spyOn } from "bun:test";

import { createProviderContextDouble } from "../../__tests__/test-utils.js";
import { ProviderError } from "../../errors.js";
import type { ProviderCache, ProviderChallenge } from "../../types.js";
import { createBypassProviderCache, createProviderCache } from "../cache.js";
import { wrapWithInstrumentation } from "../instrumentation.js";
import { closedEnum } from "../request-telemetry.js";
import {
	APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY,
	createResolverClientFromEnvForTests,
} from "../resolver.js";
import { ResolverTelemetryCollector } from "../resolver-telemetry.js";
import { createHypersolutionsResolverVendorAdapter } from "../resolver-vendors/hypersolutions.js";
import type { ResolverVendorTransport } from "../resolver-vendors/types.js";
import { createTraceContext } from "../trace.js";

const ENGINE_KEY = "hyper-engine-credential-must-stay-private";
const STATE_COOKIE = "session-cookie-must-stay-private";
const PAYLOAD = "generated-payload-must-stay-private";
const USER_AGENT = "Mozilla/5.0 bound-session-agent";
const PAGE_URL = "https://shop.example.com/protected";
const SCRIPT_URL = "https://shop.example.com/.well-known/sbsd?v=uuid";
const IP_URL = "https://ip.hypersolutions.co/ip";
const HYPER_URL = "https://akm.hypersolutions.co/sbsd";
const PHASES = ["measure_ip", "fetch_script", "generate_payload", "post_payload"] as const;
type HyperPhase = (typeof PHASES)[number];

function challenge(passive = false): ProviderChallenge {
	return {
		kind: "akamai_sbsd",
		pageUrl: PAGE_URL,
		scriptUrl: passive ? SCRIPT_URL : `${SCRIPT_URL}&t=token`,
		stateCookieName: passive ? "bm_so" : "sbsd_o",
	};
}

function harness(
	options: {
		readonly cache?: ProviderCache;
		readonly missingCredentials?: boolean;
		readonly missingTransport?: boolean;
		readonly failPhase?: HyperPhase;
		readonly upstreamVerdict?: boolean;
		readonly failRound?: number;
	} = {},
) {
	const telemetry = new ResolverTelemetryCollector();
	const recordAttempt = spyOn(telemetry, "recordVendorAttempt");
	const calls: HyperPhase[] = [];
	const payloadIndices: number[] = [];
	let solveCalls = 0;
	let factoryCalls = 0;
	let generatedPayloads = 0;
	let postedPayloads = 0;
	function invoke(phase: HyperPhase, round = 1) {
		calls.push(phase);
		if (options.failPhase === phase && (options.failRound ?? 1) === round) {
			if (options.upstreamVerdict) return 403;
			throw new Error("protocol connection failed");
		}
		return 200;
	}
	const transport: ResolverVendorTransport = {
		sessionHeaders: { "User-Agent": USER_AGENT, "Accept-Language": "en-US" },
		getCookie: () => STATE_COOKIE,
		async fetch(url, init) {
			const phase =
				url === IP_URL ? "measure_ip" : init.method === "GET" ? "fetch_script" : "post_payload";
			if (phase === "measure_ip") expect(init.headers?.["x-api-key"]).toBe(ENGINE_KEY);
			else expect(new URL(url).origin).toBe("https://shop.example.com");
			const status = invoke(phase, phase === "post_payload" ? ++postedPayloads : 1);
			return {
				status,
				headers: {},
				body: phase === "measure_ip" ? '{"ip":"203.0.113.42"}' : "measured script",
				cookies: [],
			};
		},
	};
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		expect(url).toBe(HYPER_URL);
		expect(new Headers(init?.headers).get("x-api-key")).toBe(ENGINE_KEY);
		const body: { index: number; userAgent: string; o: string } = JSON.parse(String(init?.body));
		expect(body.userAgent).toBe(USER_AGENT);
		expect(body.o).toBe(STATE_COOKIE);
		payloadIndices.push(body.index);
		const status = invoke("generate_payload", ++generatedPayloads);
		return Response.json({ payload: PAYLOAD }, { status });
	}) as typeof fetch;
	const resolver = createResolverClientFromEnvForTests(
		{ kinds: ["akamai_sbsd"], clientProfile: "safari17_0" },
		options.missingCredentials ? {} : { [APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY]: ENGINE_KEY },
		{
			allowedHosts: ["shop.example.com"],
			telemetry,
			cache: options.cache,
			...(options.missingTransport ? {} : { createTransport: () => transport }),
		},
		{
			hypersolutions(configuration, timeoutMs, allowedHosts) {
				factoryCalls++;
				expect(configuration).toBe(ENGINE_KEY);
				const adapter = createHypersolutionsResolverVendorAdapter({
					apiKey: configuration,
					timeoutMs,
					allowedHosts,
					fetchImpl,
				});
				return {
					...adapter,
					async solve(...args) {
						solveCalls++;
						return adapter.solve(...args);
					},
				};
			},
		},
	);
	return {
		resolver,
		telemetry,
		recordAttempt,
		calls,
		payloadIndices,
		get solveCalls() {
			return solveCalls;
		},
		get factoryCalls() {
			return factoryCalls;
		},
	};
}

function expectPrivateMaterialAbsent(value: unknown): void {
	const text = JSON.stringify(value);
	for (const secret of [ENGINE_KEY, STATE_COOKIE, PAYLOAD, USER_AGENT, PAGE_URL]) {
		expect(text).not.toContain(secret);
	}
}

function expectPublicExhaustion(error: unknown): void {
	expect(error).toBeInstanceOf(ProviderError);
	if (!(error instanceof ProviderError)) throw error;
	expect(error.message).toBe("The challenge could not be resolved.");
	expect(error.code).toBe("RESOLVER_CHAIN_EXHAUSTED");
	expect(error.details).toEqual({
		challengeKind: "akamai_sbsd",
		attempts: 1,
		outcome: "exhausted",
		retryable: false,
	});
	expectPrivateMaterialAbsent(error);
}

describe("hypersolutions resolver telemetry integration", () => {
	it("retains the passive phase spans with request tracing while recording one vendor invocation", async () => {
		const run = harness();
		const trace = createTraceContext();
		const context = wrapWithInstrumentation(
			createProviderContextDouble({ trace, resolver: run.resolver }),
		);
		await context.resolver.solve(challenge(true));
		expect(run.solveCalls).toBe(1);
		expect(run.recordAttempt).toHaveBeenCalledTimes(1);
		expect(trace.getSpans().map(({ name }) => name)).toEqual([
			"resolver.solve",
			"resolver.vendor.attempt",
			...[...PHASES, "generate_payload", "post_payload"].map((phase) => `resolver.vendor.${phase}`),
		]);
		const log = run.telemetry.toLogPayload()!;
		expect(log.attemptSamples?.[0]?.diagnostics).toEqual({
			phase: "post_payload",
			attemptIndex: 1,
		});
		expect(run.telemetry.toHeaderPayload(log).attemptSamples).toEqual([
			{
				v: closedEnum("hypersolutions"),
				p: closedEnum("post_payload"),
				o: closedEnum("ok"),
				ms: expect.any(Number),
			},
		]);
		expectPrivateMaterialAbsent(log);
	});

	it.each([
		["hard", false],
		["passive", true],
	] as const)("records one actual adapter invocation for %s SBSD", async (_mode, passive) => {
		const run = harness({
			cache: createProviderCache({ providerId: crypto.randomUUID(), redisUrl: "" }),
		});
		await expect(run.resolver.solve(challenge(passive))).resolves.toEqual({
			form: "cookie_state",
			kind: "akamai_sbsd",
			outcome: "payload_accepted",
			verified: false,
			stateCookieName: passive ? "bm_so" : "sbsd_o",
		});
		expect(run.factoryCalls).toBe(1);
		expect(run.solveCalls).toBe(1);
		expect(run.recordAttempt).toHaveBeenCalledTimes(1);
		expect(run.calls).toEqual(
			passive ? [...PHASES, "generate_payload", "post_payload"] : [...PHASES],
		);
		expect(run.payloadIndices).toEqual(passive ? [0, 1] : [0]);
		const log = run.telemetry.toLogPayload()!;
		expect(log).toEqual({
			outcome: "solved",
			challengeKind: "akamai_sbsd",
			solveMs: expect.any(Number),
			cacheStatus: "not_cacheable",
			cacheWrite: { written: false, reason: "not_cacheable" },
			identitySource: "declared",
			attempts: 1,
			failovers: 0,
			vendorChain: ["hypersolutions"],
			vendorUsed: "hypersolutions",
			pollCount: 0,
			attemptSamples: [
				{
					v: "hypersolutions",
					p: "post_payload",
					o: "ok",
					ms: expect.any(Number),
					diagnostics: { phase: "post_payload", attemptIndex: 1 },
				},
			],
		});
		const header = run.telemetry.toHeaderPayload(log);
		expect(header).toEqual({
			outcome: closedEnum("solved"),
			cacheStatus: closedEnum("not_cacheable"),
			solveMs: expect.any(Number),
			attempts: 1,
			failovers: 0,
			vendorUsed: closedEnum("hypersolutions"),
			vendorChain: [closedEnum("hypersolutions")],
			pollCount: 0,
			identitySource: closedEnum("declared"),
			attemptSamples: [
				{
					v: closedEnum("hypersolutions"),
					p: closedEnum("post_payload"),
					o: closedEnum("ok"),
					ms: expect.any(Number),
				},
			],
		});
		expectPrivateMaterialAbsent(log);
		expectPrivateMaterialAbsent(header);
	});

	it.each([
		...PHASES,
	])("records one invocation and projects the real %s failure", async (phase) => {
		const run = harness({ failPhase: phase });
		const error: unknown = await run.resolver.solve(challenge()).catch((cause: unknown) => cause);
		expectPublicExhaustion(error);
		expect(run.solveCalls).toBe(1);
		expect(run.recordAttempt).toHaveBeenCalledTimes(1);
		expect(run.calls).toEqual(PHASES.slice(0, PHASES.indexOf(phase) + 1));
		const log = run.telemetry.toLogPayload()!;
		expect(log.attempts).toBe(1);
		expect(log.outcome).toBe("exhausted");
		expect(log.identitySource).toBe("declared");
		expect(log.identityFailure).toBeUndefined();
		expect(log.attemptSamples).toEqual([
			{
				v: "hypersolutions",
				p: phase,
				o: "error",
				ms: expect.any(Number),
				e: "transport_failure",
				diagnostics: {
					cause: { name: "Error", message: "protocol connection failed" },
					phase,
					attemptIndex: 1,
				},
			},
		]);
		const header = run.telemetry.toHeaderPayload(log);
		expect(header.attemptSamples).toEqual([
			{
				v: closedEnum("hypersolutions"),
				p: closedEnum(phase),
				o: closedEnum("error"),
				ms: expect.any(Number),
			},
		]);
		expectPrivateMaterialAbsent(log);
		expectPrivateMaterialAbsent(header);
	});

	it.each([
		"fetch_script",
		"post_payload",
	] as const)("keeps %s from the span when an upstream verdict has no phase property", async (phase) => {
		const run = harness({ failPhase: phase, upstreamVerdict: true });
		await expect(run.resolver.solve(challenge())).rejects.toMatchObject({
			name: "ResolverChallengeVerdictError",
			reason: "solve_failed",
		});
		expect(run.solveCalls).toBe(1);
		expect(run.recordAttempt).toHaveBeenCalledTimes(1);
		const log = run.telemetry.toLogPayload()!;
		expect(log.outcome).toBe("error");
		expect(log.attemptSamples).toEqual([
			{
				v: "hypersolutions",
				p: phase,
				o: "error",
				ms: expect.any(Number),
				e: "unexpected",
				diagnostics: { phase, attemptIndex: 1 },
			},
		]);
		expect(run.telemetry.toHeaderPayload(log).attemptSamples).toEqual([
			{
				v: closedEnum("hypersolutions"),
				p: closedEnum(phase),
				o: closedEnum("error"),
				ms: expect.any(Number),
			},
		]);
	});

	it("records one invocation when the passive protocol fails during its second payload round", async () => {
		const run = harness({ failPhase: "post_payload", failRound: 2 });
		expectPublicExhaustion(
			await run.resolver.solve(challenge(true)).catch((cause: unknown) => cause),
		);
		expect(run.calls).toEqual([...PHASES, "generate_payload", "post_payload"]);
		expect(run.payloadIndices).toEqual([0, 1]);
		expect(run.solveCalls).toBe(1);
		expect(run.recordAttempt).toHaveBeenCalledTimes(1);
		expect(run.telemetry.toLogPayload()?.attempts).toBe(1);
	});

	it("treats an SBSD bypass cache as disabled without claiming a write", async () => {
		const run = harness({ cache: createBypassProviderCache({ providerId: crypto.randomUUID() }) });
		await run.resolver.solve(challenge());
		const log = run.telemetry.toLogPayload()!;
		expect(log.cacheStatus).toBe("disabled");
		expect(log.cacheWrite).toBeUndefined();
		expect(run.solveCalls).toBe(1);
		expect(run.recordAttempt).toHaveBeenCalledTimes(1);
		expect(run.telemetry.toHeaderPayload(log).cacheStatus).toBe(closedEnum("disabled"));
	});

	it.each([
		"missing_credentials",
		"missing_transport",
	] as const)("keeps %s unavailable without leaking reasons into the tenant details", async (reason) => {
		const run = harness({
			missingCredentials: reason === "missing_credentials",
			missingTransport: reason === "missing_transport",
		});
		expectPublicExhaustion(await run.resolver.solve(challenge()).catch((cause: unknown) => cause));
		expect(run.factoryCalls).toBe(reason === "missing_credentials" ? 0 : 1);
		expect(run.solveCalls).toBe(0);
		expect(run.calls).toEqual([]);
		expect(run.recordAttempt).toHaveBeenCalledTimes(1);
		const log = run.telemetry.toLogPayload()!;
		expect(log.identitySource).toBe("declared");
		expect(log.identityFailure).toBeUndefined();
		expect(log.attemptSamples).toEqual([
			{
				v: "hypersolutions",
				p: "create_task",
				o: "error",
				ms: expect.any(Number),
				e: reason,
				diagnostics: { attemptIndex: 1 },
			},
		]);
		expect(run.telemetry.toHeaderPayload(log).attemptSamples).toEqual([
			{
				v: closedEnum("hypersolutions"),
				p: closedEnum("create_task"),
				o: closedEnum("error"),
				ms: expect.any(Number),
			},
		]);
		expectPrivateMaterialAbsent(log);
	});
});
