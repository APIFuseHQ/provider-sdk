import type { ProviderChallengeKind, ProviderResolverVendor } from "../types.js";
import type { ResolverVendorUnavailableReason } from "./resolver-vendors/types.js";

export type ResolverVendorCooldownReason = "allocation_exhausted";

export type ResolverVendorSolveStats = {
	readonly kind: ProviderChallengeKind;
	/** Attempts in the rolling window that reached a vendor verdict (success or vendor failure). */
	readonly samples: number;
	readonly successes: number;
	/** Median duration of the successful solves in the window; absent until one succeeded. */
	readonly p50Ms?: number;
};

/**
 * Read-only view of one resolver vendor: the last balance the host polled, an active
 * allocation-exhausted cooldown, rolling solve statistics per challenge kind, and how
 * many solves finished after their caller had already left.
 */
export type ResolverVendorHealthSnapshot = {
	readonly vendor: ProviderResolverVendor;
	readonly balance?: { readonly amount: number; readonly checkedAtMs: number };
	readonly balanceError?: {
		readonly reason: ResolverVendorUnavailableReason | "unexpected";
		readonly checkedAtMs: number;
	};
	readonly cooldown?: {
		readonly reason: ResolverVendorCooldownReason;
		readonly startedAtMs: number;
		readonly untilMs: number;
	};
	readonly solves: readonly ResolverVendorSolveStats[];
	readonly detached: { readonly completed: number; readonly failed: number };
};

export type ResolverVendorBalanceRecord =
	| { readonly balance: number; readonly checkedAtMs: number }
	| {
			readonly error: ResolverVendorUnavailableReason | "unexpected";
			readonly checkedAtMs: number;
	  };

/**
 * Shared vendor state behind one resolver chain or one process: cooldowns, rolling solve
 * samples, polled balances and detached outcomes. The server binds one registry to
 * `process.env`; a chain built with another env object, or `createResolverClient`
 * without a `vendorHealth` option, gets its own so unrelated chains never share state.
 */
export interface ResolverVendorHealthRegistry {
	recordSolveSample(
		vendor: ProviderResolverVendor,
		kind: ProviderChallengeKind,
		sample: { readonly ms: number; readonly ok: boolean },
	): void;
	solveP50Ms(vendor: ProviderResolverVendor, kind: ProviderChallengeKind): number | undefined;
	startCooldown(
		vendor: ProviderResolverVendor,
		reason: ResolverVendorCooldownReason,
		startedAtMs: number,
		untilMs: number,
	): void;
	/** Epoch ms until which the vendor is skipped, or undefined when no cooldown is active. */
	cooldownUntilMs(vendor: ProviderResolverVendor, nowMs: number): number | undefined;
	recordBalance(vendor: ProviderResolverVendor, record: ResolverVendorBalanceRecord): void;
	recordDetachedOutcome(vendor: ProviderResolverVendor, outcome: "completed" | "failed"): void;
	snapshot(nowMs?: number): readonly ResolverVendorHealthSnapshot[];
	reset(): void;
}

const ROLLING_SOLVE_WINDOW = 20;
/** Fewer successful samples than this say nothing reliable about a vendor's speed. */
const MIN_P50_SAMPLES = 3;

type SolveSample = { readonly ms: number; readonly ok: boolean };

type VendorHealthState = {
	balance?: { amount: number; checkedAtMs: number };
	balanceError?: {
		reason: ResolverVendorUnavailableReason | "unexpected";
		checkedAtMs: number;
	};
	cooldown?: { reason: ResolverVendorCooldownReason; startedAtMs: number; untilMs: number };
	readonly solves: Map<ProviderChallengeKind, SolveSample[]>;
	detachedCompleted: number;
	detachedFailed: number;
};

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
		: (sorted[middle] as number);
}

function solveStats(kind: ProviderChallengeKind, window: readonly SolveSample[]): ResolverVendorSolveStats {
	const successes = window.filter((sample) => sample.ok);
	return {
		kind,
		samples: window.length,
		successes: successes.length,
		...(successes.length >= MIN_P50_SAMPLES
			? { p50Ms: median(successes.map((sample) => sample.ms)) }
			: {}),
	};
}

export function createResolverVendorHealthRegistry(): ResolverVendorHealthRegistry {
	const vendors = new Map<ProviderResolverVendor, VendorHealthState>();
	const stateFor = (vendor: ProviderResolverVendor): VendorHealthState => {
		let state = vendors.get(vendor);
		if (!state) {
			state = { solves: new Map(), detachedCompleted: 0, detachedFailed: 0 };
			vendors.set(vendor, state);
		}
		return state;
	};
	const cooldownUntilMs = (vendor: ProviderResolverVendor, nowMs: number): number | undefined => {
		const state = vendors.get(vendor);
		if (!state?.cooldown) return undefined;
		if (state.cooldown.untilMs <= nowMs) {
			state.cooldown = undefined;
			return undefined;
		}
		return state.cooldown.untilMs;
	};
	return {
		recordSolveSample(vendor, kind, sample) {
			const state = stateFor(vendor);
			const window = state.solves.get(kind) ?? [];
			window.push({ ms: Math.max(0, sample.ms), ok: sample.ok });
			if (window.length > ROLLING_SOLVE_WINDOW) {
				window.splice(0, window.length - ROLLING_SOLVE_WINDOW);
			}
			state.solves.set(kind, window);
		},
		solveP50Ms(vendor, kind) {
			const window = vendors.get(vendor)?.solves.get(kind);
			return window ? solveStats(kind, window).p50Ms : undefined;
		},
		startCooldown(vendor, reason, startedAtMs, untilMs) {
			stateFor(vendor).cooldown = { reason, startedAtMs, untilMs };
		},
		cooldownUntilMs,
		recordBalance(vendor, record) {
			const state = stateFor(vendor);
			if ("balance" in record) {
				state.balance = { amount: record.balance, checkedAtMs: record.checkedAtMs };
				state.balanceError = undefined;
				return;
			}
			state.balanceError = { reason: record.error, checkedAtMs: record.checkedAtMs };
		},
		recordDetachedOutcome(vendor, outcome) {
			const state = stateFor(vendor);
			if (outcome === "completed") state.detachedCompleted += 1;
			else state.detachedFailed += 1;
		},
		snapshot(nowMs = Date.now()) {
			return [...vendors.entries()].map(([vendor, state]) => {
				const activeCooldownUntilMs = cooldownUntilMs(vendor, nowMs);
				return {
					vendor,
					...(state.balance ? { balance: { ...state.balance } } : {}),
					...(state.balanceError ? { balanceError: { ...state.balanceError } } : {}),
					...(activeCooldownUntilMs !== undefined && state.cooldown
						? { cooldown: { ...state.cooldown } }
						: {}),
					solves: [...state.solves.entries()].map(([kind, window]) => solveStats(kind, window)),
					detached: { completed: state.detachedCompleted, failed: state.detachedFailed },
				};
			});
		},
		reset() {
			vendors.clear();
		},
	};
}

const registriesByEnv = new WeakMap<object, ResolverVendorHealthRegistry>();

/** The registry bound to an env object; `process.env` owns the process-wide one. */
export function resolverVendorHealthForEnv(env: object): ResolverVendorHealthRegistry {
	let registry = registriesByEnv.get(env);
	if (!registry) {
		registry = createResolverVendorHealthRegistry();
		registriesByEnv.set(env, registry);
	}
	return registry;
}

/** Snapshot of the process-wide registry (the one bound to `process.env`); safe to publish. */
export function getResolverVendorHealthSnapshot(
	nowMs: number = Date.now(),
): readonly ResolverVendorHealthSnapshot[] {
	return resolverVendorHealthForEnv(process.env).snapshot(nowMs);
}

/** Internal test seam; deliberately not re-exported from the package root. */
export function resetResolverVendorHealthForTests(): void {
	resolverVendorHealthForEnv(process.env).reset();
}
