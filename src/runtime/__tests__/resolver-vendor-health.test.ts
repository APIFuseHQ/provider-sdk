import { beforeEach, describe, expect, it } from "bun:test";

import type {
	ChallengeSolution,
	ProviderCache,
	ProviderCacheGetOrSetOptions,
	ProviderChallenge,
	ProviderResolverVendor,
} from "../../types.js";
import { ProviderError } from "../../errors.js";
import { createProviderCache, resetProviderCacheForTests } from "../cache.js";
import {
	APIFUSE__RESOLVER__2CAPTCHA__API_KEY,
	APIFUSE__RESOLVER__CAPSOLVER__API_KEY,
	APIFUSE__RESOLVER__VENDOR_COOLDOWN_MS,
	createResolverClient,
	createResolverClientFromEnvForTests,
	DEFAULT_RESOLVER_TIMEOUT_MS,
	DEFAULT_RESOLVER_VENDOR_COOLDOWN_MS,
	getResolverSolutionSource,
	refreshResolverVendorBalancesForTests,
	RESOLVER_BUDGET_MARGIN_MS,
	RESOLVER_TOKEN_SOLUTION_TTL_MS_BY_KIND,
	resetResolverInFlightSolvesForTests,
} from "../resolver.js";
import {
	ResolverTelemetryCollector,
	type ResolverFailoverTelemetryEvent,
	type ResolverOutcomeTelemetryEvent,
	type ResolverTelemetrySink,
} from "../resolver-telemetry.js";
import {
	getResolverVendorHealthSnapshot,
	resetResolverVendorHealthForTests,
} from "../resolver-vendor-health.js";
import { createCapsolverResolverVendorAdapter } from "../resolver-vendors/capsolver.js";
import { createTwoCaptchaResolverVendorAdapter } from "../resolver-vendors/twocaptcha.js";
import {
	type ResolverVendorAdapter,
	ResolverVendorUnavailableError,
} from "../resolver-vendors/types.js";

const CHALLENGE = {
	kind: "aws_waf",
	pageUrl: "https://shop.example.com/protected",
	siteKey: "waf-key",
	captchaScript: "https://shop.example.com/captcha.js",
	context: "ctx",
	iv: "iv",
} satisfies ProviderChallenge;

type Deferred<T> = {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function tokenSolution(token: string): ChallengeSolution {
	return { form: "token", token };
}

function createStubAdapter(
	id: ProviderResolverVendor,
	behavior: (signal: AbortSignal, call: number) => Promise<ChallengeSolution>,
) {
	const state = { solveCalls: 0, balanceCalls: 0, signals: [] as AbortSignal[] };
	let firstCall = deferred<void>();
	const adapter: ResolverVendorAdapter = {
		id,
		supports: (kind) => kind === "aws_waf",
		async getBalance() {
			state.balanceCalls += 1;
			return { balance: 1 };
		},
		async solve(_challenge, _identity, signal) {
			state.solveCalls += 1;
			state.signals.push(signal);
			firstCall.resolve();
			return await behavior(signal, state.solveCalls);
		},
	};
	return {
		adapter,
		state,
		called: () => firstCall.promise,
		rearm: () => {
			firstCall = deferred<void>();
		},
	};
}

function createRecordingCache(): {
	readonly cache: ProviderCache;
	readonly setCalls: { readonly key: string; readonly options: ProviderCacheGetOrSetOptions }[];
} {
	const inner = createProviderCache({ providerId: "resolver-health-test", redisUrl: "" });
	const setCalls: { key: string; options: ProviderCacheGetOrSetOptions }[] = [];
	const cache: ProviderCache = {
		key: (namespace, parts, options) => inner.key(namespace, parts, options),
		get: (key) => inner.get(key),
		async set(key, value, options) {
			setCalls.push({ key, options });
			await inner.set(key, value, options);
		},
		delete: (key) => inner.delete(key),
		getOrSet: (key, loader, options) => inner.getOrSet(key, loader, options),
		responseMeta: () => inner.responseMeta(),
	};
	return { cache, setCalls };
}

function createEventSink(): {
	readonly sink: ResolverTelemetrySink;
	readonly collector: ResolverTelemetryCollector;
	readonly failovers: ResolverFailoverTelemetryEvent[];
	readonly outcomes: ResolverOutcomeTelemetryEvent[];
	nextOutcome(outcome: ResolverOutcomeTelemetryEvent["outcome"]): Promise<ResolverOutcomeTelemetryEvent>;
} {
	const collector = new ResolverTelemetryCollector();
	const failovers: ResolverFailoverTelemetryEvent[] = [];
	const outcomes: ResolverOutcomeTelemetryEvent[] = [];
	const waiters: {
		outcome: ResolverOutcomeTelemetryEvent["outcome"];
		resolve: (event: ResolverOutcomeTelemetryEvent) => void;
	}[] = [];
	const sink: ResolverTelemetrySink = {
		recordIdentity: (event) => collector.recordIdentity(event),
		recordCacheRead: (event) => collector.recordCacheRead(event),
		recordCacheWrite: (event) => collector.recordCacheWrite(event),
		recordVendorAttempt: (event) => collector.recordVendorAttempt(event),
		recordFailover(event) {
			failovers.push(event);
			collector.recordFailover(event);
		},
		recordOutcome(event) {
			outcomes.push(event);
			collector.recordOutcome(event);
			for (const waiter of waiters.splice(0)) {
				if (waiter.outcome === event.outcome) waiter.resolve(event);
				else waiters.push(waiter);
			}
		},
	};
	return {
		sink,
		collector,
		failovers,
		outcomes,
		nextOutcome(outcome) {
			return new Promise((resolve) => waiters.push({ outcome, resolve }));
		},
	};
}

function exhaustedAttempts(error: unknown): number {
	expect(error).toBeInstanceOf(ProviderError);
	expect((error as ProviderError).code).toBe("RESOLVER_CHAIN_EXHAUSTED");
	return ((error as ProviderError).details as { attempts: number }).attempts;
}

beforeEach(() => {
	resetProviderCacheForTests();
	resetResolverVendorHealthForTests();
	resetResolverInFlightSolvesForTests();
});

describe("A1 token-form solution cache", () => {
	it("caches a token-form aws_waf solution for the kind TTL and serves the next solve from the cache", async () => {
		const { cache, setCalls } = createRecordingCache();
		const vendor = createStubAdapter("2captcha", async () => tokenSolution("waf-token-1"));
		const first = createEventSink();
		const before = Date.now();
		const solved = await createResolverClient({
			kinds: ["aws_waf"],
			adapters: [vendor.adapter],
			cache,
			telemetry: first.sink,
		}).solve(CHALLENGE);

		expect(solved).toEqual({ form: "token", token: "waf-token-1" });
		expect(getResolverSolutionSource(solved)).toBe("vendor");
		expect(first.collector.toLogPayload()).toMatchObject({
			cacheStatus: "miss",
			cacheWrite: { written: true },
			outcome: "solved",
		});
		const ttlMs = setCalls[0]?.options.ttlMs ?? 0;
		expect(ttlMs).toBeGreaterThan(RESOLVER_TOKEN_SOLUTION_TTL_MS_BY_KIND.aws_waf - 1_000);
		expect(ttlMs).toBeLessThanOrEqual(
			RESOLVER_TOKEN_SOLUTION_TTL_MS_BY_KIND.aws_waf + (Date.now() - before),
		);

		const second = createEventSink();
		const cached = await createResolverClient({
			kinds: ["aws_waf"],
			adapters: [vendor.adapter],
			cache,
			telemetry: second.sink,
		}).solve(CHALLENGE);

		expect(cached).toEqual({ form: "token", token: "waf-token-1" });
		expect(getResolverSolutionSource(cached)).toBe("cache");
		expect(second.collector.toLogPayload()).toMatchObject({ cacheStatus: "hit", outcome: "cached" });
		expect(vendor.state.solveCalls).toBe(1);
	});

	it("prefers the vendor-reported token expiry over the kind TTL", async () => {
		const { cache, setCalls } = createRecordingCache();
		const expiresInMs = 30_000;
		const vendor = createStubAdapter("2captcha", async () => ({
			form: "token",
			token: "waf-token-2",
			expires: (Date.now() + expiresInMs) / 1_000,
		}));
		await createResolverClient({ kinds: ["aws_waf"], adapters: [vendor.adapter], cache }).solve(
			CHALLENGE,
		);

		const ttlMs = setCalls[0]?.options.ttlMs ?? 0;
		expect(ttlMs).toBeGreaterThan(expiresInMs - 1_000);
		expect(ttlMs).toBeLessThanOrEqual(expiresInMs);
	});
});

describe("A2 detached completion and in-flight joining", () => {
	it("keeps polling after the caller aborts, writes the cache, and reports detached_completed", async () => {
		const { cache } = createRecordingCache();
		const poll = deferred<ChallengeSolution>();
		const vendor = createStubAdapter("2captcha", () => poll.promise);
		const first = createEventSink();
		const resolver = createResolverClient({
			kinds: ["aws_waf"],
			adapters: [vendor.adapter],
			cache,
			telemetry: first.sink,
		});
		const caller = new AbortController();
		const callerLeft = new Error("caller closed the connection");
		const solving = resolver.solve(CHALLENGE, caller.signal);
		await vendor.called();
		caller.abort(callerLeft);

		await expect(solving).rejects.toBe(callerLeft);
		expect(first.outcomes.map((event) => event.outcome)).toEqual(["aborted"]);
		expect(vendor.state.signals[0]?.aborted).toBe(false);

		const detached = first.nextOutcome("detached_completed");
		poll.resolve(tokenSolution("waf-token-late"));
		await detached;

		expect(getResolverVendorHealthSnapshot().find((entry) => entry.vendor === "2captcha")).toMatchObject({
			detached: { completed: 1, failed: 0 },
		});
		const second = createEventSink();
		const cached = await createResolverClient({
			kinds: ["aws_waf"],
			adapters: [vendor.adapter],
			cache,
			telemetry: second.sink,
		}).solve(CHALLENGE);
		expect(cached).toEqual({ form: "token", token: "waf-token-late" });
		expect(second.collector.toLogPayload()?.cacheStatus).toBe("hit");
		expect(vendor.state.solveCalls).toBe(1);
	});

	it("reports detached_failed when the abandoned poll fails", async () => {
		const { cache } = createRecordingCache();
		const poll = deferred<ChallengeSolution>();
		const vendor = createStubAdapter("2captcha", () => poll.promise);
		const sink = createEventSink();
		const caller = new AbortController();
		const solving = createResolverClient({
			kinds: ["aws_waf"],
			adapters: [vendor.adapter],
			cache,
			telemetry: sink.sink,
		}).solve(CHALLENGE, caller.signal);
		await vendor.called();
		caller.abort(new Error("gone"));
		await expect(solving).rejects.toThrow("gone");

		const failed = sink.nextOutcome("detached_failed");
		poll.reject(new ResolverVendorUnavailableError("2captcha", "transport_failure"));
		await failed;
		expect(getResolverVendorHealthSnapshot().find((entry) => entry.vendor === "2captcha")).toMatchObject({
			detached: { completed: 0, failed: 1 },
		});
	});

	it("lets a second caller join the in-flight solve instead of creating another vendor task", async () => {
		const { cache } = createRecordingCache();
		const poll = deferred<ChallengeSolution>();
		const vendor = createStubAdapter("2captcha", () => poll.promise);
		const first = createEventSink();
		const caller = new AbortController();
		const abandoned = createResolverClient({
			kinds: ["aws_waf"],
			adapters: [vendor.adapter],
			cache,
			telemetry: first.sink,
		}).solve(CHALLENGE, caller.signal);
		await vendor.called();
		caller.abort(new Error("gone"));
		await expect(abandoned).rejects.toThrow("gone");

		const second = createEventSink();
		const joined = createResolverClient({
			kinds: ["aws_waf"],
			adapters: [vendor.adapter],
			cache,
			telemetry: second.sink,
		}).solve(CHALLENGE);
		const detached = first.nextOutcome("detached_completed");
		poll.resolve(tokenSolution("waf-token-shared"));

		expect(await joined).toEqual({ form: "token", token: "waf-token-shared" });
		await detached;
		expect(second.collector.toLogPayload()).toMatchObject({
			cacheStatus: "in_flight",
			outcome: "solved",
		});
		expect(vendor.state.solveCalls).toBe(1);
	});

	it("stops the vendor with the caller when no cache can keep the result", async () => {
		const vendor = createStubAdapter(
			"2captcha",
			(signal) =>
				new Promise<ChallengeSolution>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const caller = new AbortController();
		const solving = createResolverClient({ kinds: ["aws_waf"], adapters: [vendor.adapter] }).solve(
			CHALLENGE,
			caller.signal,
		);
		await vendor.called();
		caller.abort(new Error("gone"));
		await expect(solving).rejects.toThrow("gone");
		expect(vendor.state.signals[0]?.aborted).toBe(true);
	});
});

describe("A3 solve budget", () => {
	it("defaults the vendor solve bound to 45 seconds", () => {
		expect(DEFAULT_RESOLVER_TIMEOUT_MS).toBe(45_000);
	});

	it("skips every vendor with budget_exceeded when the remaining budget is inside the margin", async () => {
		const capsolver = createStubAdapter("capsolver", async () => tokenSolution("a"));
		const twoCaptcha = createStubAdapter("2captcha", async () => tokenSolution("b"));
		const sink = createEventSink();
		const error = await createResolverClient({
			kinds: ["aws_waf"],
			adapters: [capsolver.adapter, twoCaptcha.adapter],
			deadlineAtMs: Date.now() + RESOLVER_BUDGET_MARGIN_MS - 1,
			telemetry: sink.sink,
		})
			.solve(CHALLENGE)
			.catch((caught: unknown) => caught);

		expect(exhaustedAttempts(error)).toBe(2);
		expect(capsolver.state.solveCalls).toBe(0);
		expect(twoCaptcha.state.solveCalls).toBe(0);
		expect(sink.failovers).toEqual([{ from: "capsolver", to: "2captcha", reason: "budget_exceeded" }]);
		expect(sink.collector.toLogPayload()?.attemptSamples?.map((sample) => sample.e)).toEqual([
			"budget_exceeded",
			"budget_exceeded",
		]);
	});

	it("skips a vendor whose measured p50 exceeds the remaining budget and uses the next one", async () => {
		let clock = 1_700_000_000_000;
		const now = () => clock;
		const slow = createStubAdapter("capsolver", async () => {
			clock += 30_000;
			return tokenSolution("slow");
		});
		const fast = createStubAdapter("2captcha", async () => {
			clock += 2_000;
			return tokenSolution("fast");
		});
		const warmup = createResolverClient({ kinds: ["aws_waf"], adapters: [slow.adapter], now });
		for (let call = 0; call < 3; call += 1) await warmup.solve(CHALLENGE);
		expect(getResolverVendorHealthSnapshot(now()).find((entry) => entry.vendor === "capsolver")).toMatchObject({
			solves: [{ kind: "aws_waf", samples: 3, successes: 3, p50Ms: 30_000 }],
		});

		const sink = createEventSink();
		const solved = await createResolverClient({
			kinds: ["aws_waf"],
			adapters: [slow.adapter, fast.adapter],
			deadlineAtMs: now() + 20_000 + RESOLVER_BUDGET_MARGIN_MS,
			telemetry: sink.sink,
			now,
		}).solve(CHALLENGE);

		expect(solved).toEqual({ form: "token", token: "fast" });
		expect(slow.state.solveCalls).toBe(3);
		expect(fast.state.solveCalls).toBe(1);
		expect(sink.failovers).toEqual([{ from: "capsolver", to: "2captcha", reason: "budget_exceeded" }]);
	});

	it("cuts an uncacheable solve at the budget deadline and reports budget_exceeded", async () => {
		const vendor = createStubAdapter(
			"2captcha",
			(signal) =>
				new Promise<ChallengeSolution>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const sink = createEventSink();
		const error = await createResolverClient({
			kinds: ["aws_waf"],
			adapters: [vendor.adapter],
			deadlineAtMs: Date.now() + RESOLVER_BUDGET_MARGIN_MS + 20,
			telemetry: sink.sink,
		})
			.solve(CHALLENGE)
			.catch((caught: unknown) => caught);

		expect(exhaustedAttempts(error)).toBe(1);
		expect(vendor.state.signals[0]?.aborted).toBe(true);
		expect(sink.collector.toLogPayload()?.attemptSamples?.[0]?.e).toBe("budget_exceeded");
	});
});

describe("A4 vendor cooldown", () => {
	function exhaustedVendor(id: ProviderResolverVendor) {
		return createStubAdapter(id, async () => {
			throw new ResolverVendorUnavailableError(id, "allocation_exhausted");
		});
	}

	it("skips a zero-balance vendor without a call for the cooldown window, then retries it", async () => {
		let clock = 1_700_000_000_000;
		const now = () => clock;
		const capsolver = exhaustedVendor("capsolver");
		const twoCaptcha = createStubAdapter("2captcha", async () => tokenSolution("fallback"));
		const chain = () =>
			createResolverClient({
				kinds: ["aws_waf"],
				adapters: [capsolver.adapter, twoCaptcha.adapter],
				now,
			});
		await chain().solve(CHALLENGE);
		expect(capsolver.state.solveCalls).toBe(1);
		expect(getResolverVendorHealthSnapshot(now()).find((entry) => entry.vendor === "capsolver")).toMatchObject({
			cooldown: {
				reason: "allocation_exhausted",
				startedAtMs: clock,
				untilMs: clock + DEFAULT_RESOLVER_VENDOR_COOLDOWN_MS,
			},
		});

		const sink = createEventSink();
		clock += DEFAULT_RESOLVER_VENDOR_COOLDOWN_MS - 1;
		await createResolverClient({
			kinds: ["aws_waf"],
			adapters: [capsolver.adapter, twoCaptcha.adapter],
			telemetry: sink.sink,
			now,
		}).solve(CHALLENGE);
		expect(capsolver.state.solveCalls).toBe(1);
		expect(sink.failovers).toEqual([{ from: "capsolver", to: "2captcha", reason: "cooldown" }]);
		expect(sink.collector.toLogPayload()?.attemptSamples?.[0]).toMatchObject({
			v: "capsolver",
			e: "cooldown",
			ms: 0,
		});

		clock += 1;
		await chain().solve(CHALLENGE);
		expect(capsolver.state.solveCalls).toBe(2);
	});

	it("reads the cooldown window from the resolver environment", async () => {
		let clock = 1_700_000_000_000;
		const capsolver = exhaustedVendor("capsolver");
		const twoCaptcha = createStubAdapter("2captcha", async () => tokenSolution("fallback"));
		const chain = () =>
			createResolverClientFromEnvForTests(
				{ kinds: ["aws_waf"] },
				{
					[APIFUSE__RESOLVER__CAPSOLVER__API_KEY]: "sk-capsolver",
					[APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: "sk-2captcha",
					[APIFUSE__RESOLVER__VENDOR_COOLDOWN_MS]: "1000",
				},
				{},
				{ capsolver: () => capsolver.adapter, "2captcha": () => twoCaptcha.adapter },
			);
		await chain().solve(CHALLENGE);
		expect(getResolverVendorHealthSnapshot(clock).find((entry) => entry.vendor === "capsolver")?.cooldown)
			.toBeDefined();
		clock = Date.now() + 1_000;
		expect(getResolverVendorHealthSnapshot(clock).find((entry) => entry.vendor === "capsolver")?.cooldown)
			.toBeUndefined();
	});
});

describe("A5 vendor balance and health snapshot", () => {
	function balanceFetch(
		response: () => Response,
		calls: { url: string; body: unknown }[],
	): typeof fetch {
		const implementation = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
			return response();
		};
		return Object.assign(implementation, {
			preconnect(_url: string | URL, _options?: Parameters<typeof fetch.preconnect>[1]): void {},
		});
	}

	it("reads the capsolver balance through POST /getBalance", async () => {
		const calls: { url: string; body: unknown }[] = [];
		const adapter = createCapsolverResolverVendorAdapter({
			apiKey: "capsolver-key",
			allowedHosts: ["shop.example.com"],
			fetchImpl: balanceFetch(() => Response.json({ errorId: 0, balance: 12.5 }), calls),
		});
		await expect(adapter.getBalance?.(new AbortController().signal)).resolves.toEqual({
			balance: 12.5,
		});
		expect(calls).toEqual([
			{ url: "https://api.capsolver.com/getBalance", body: { clientKey: "capsolver-key" } },
		]);
	});

	it("reads the 2captcha balance through POST /getBalance and classifies a zero-balance reply", async () => {
		const calls: { url: string; body: unknown }[] = [];
		const adapter = createTwoCaptchaResolverVendorAdapter({
			apiKey: "twocaptcha-key",
			allowedHosts: ["shop.example.com"],
			fetchImpl: balanceFetch(() => Response.json({ errorId: 0, balance: 3.25 }), calls),
		});
		await expect(adapter.getBalance?.(new AbortController().signal)).resolves.toEqual({
			balance: 3.25,
		});
		expect(calls).toEqual([
			{ url: "https://api.2captcha.com/getBalance", body: { clientKey: "twocaptcha-key" } },
		]);

		const exhausted = createTwoCaptchaResolverVendorAdapter({
			apiKey: "twocaptcha-key",
			allowedHosts: ["shop.example.com"],
			fetchImpl: balanceFetch(
				() => Response.json({ errorId: 1, errorCode: "ERROR_ZERO_BALANCE" }),
				[],
			),
		});
		await expect(exhausted.getBalance?.(new AbortController().signal)).rejects.toMatchObject({
			vendor: "2captcha",
			reason: "allocation_exhausted",
		});
	});

	it("publishes balances per configured vendor without touching the solve path", async () => {
		const capsolver = createStubAdapter("capsolver", async () => tokenSolution("a"));
		const twoCaptcha: ResolverVendorAdapter = {
			id: "2captcha",
			supports: () => true,
			async getBalance() {
				throw new ResolverVendorUnavailableError("2captcha", "transport_failure");
			},
			async solve() {
				throw new Error("solve must not run during a balance refresh");
			},
		};
		const snapshot = await refreshResolverVendorBalancesForTests(
			{ kinds: ["aws_waf"] },
			{
				[APIFUSE__RESOLVER__CAPSOLVER__API_KEY]: "sk-capsolver",
				[APIFUSE__RESOLVER__2CAPTCHA__API_KEY]: "sk-2captcha",
			},
			{ capsolver: () => capsolver.adapter, "2captcha": () => twoCaptcha },
		);

		expect(capsolver.state.solveCalls).toBe(0);
		expect(capsolver.state.balanceCalls).toBe(1);
		expect(snapshot.find((entry) => entry.vendor === "capsolver")).toMatchObject({
			balance: { amount: 1 },
		});
		expect(snapshot.find((entry) => entry.vendor === "2captcha")).toMatchObject({
			balanceError: { reason: "transport_failure" },
		});

		await createResolverClient({ kinds: ["aws_waf"], adapters: [capsolver.adapter] }).solve(CHALLENGE);
		expect(capsolver.state.balanceCalls).toBe(1);
		expect(getResolverVendorHealthSnapshot().find((entry) => entry.vendor === "capsolver")).toMatchObject({
			balance: { amount: 1 },
			solves: [{ kind: "aws_waf", samples: 1, successes: 1 }],
		});
	});
});
