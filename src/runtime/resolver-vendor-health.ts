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
 * Read-only, process-wide view of one resolver vendor: the last balance the host polled,
 * an active allocation-exhausted cooldown, rolling solve statistics per challenge kind,
 * and how many solves finished after their caller had already left.
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

const vendorHealth = new Map<ProviderResolverVendor, VendorHealthState>();

function stateFor(vendor: ProviderResolverVendor): VendorHealthState {
	let state = vendorHealth.get(vendor);
	if (!state) {
		state = { solves: new Map(), detachedCompleted: 0, detachedFailed: 0 };
		vendorHealth.set(vendor, state);
	}
	return state;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
		: (sorted[middle] as number);
}

export function recordResolverVendorSolveSample(
	vendor: ProviderResolverVendor,
	kind: ProviderChallengeKind,
	sample: SolveSample,
): void {
	const state = stateFor(vendor);
	const window = state.solves.get(kind) ?? [];
	window.push({ ms: Math.max(0, sample.ms), ok: sample.ok });
	if (window.length > ROLLING_SOLVE_WINDOW) window.splice(0, window.length - ROLLING_SOLVE_WINDOW);
	state.solves.set(kind, window);
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

export function resolverVendorSolveP50Ms(
	vendor: ProviderResolverVendor,
	kind: ProviderChallengeKind,
): number | undefined {
	const window = vendorHealth.get(vendor)?.solves.get(kind);
	return window ? solveStats(kind, window).p50Ms : undefined;
}

export function startResolverVendorCooldown(
	vendor: ProviderResolverVendor,
	reason: ResolverVendorCooldownReason,
	startedAtMs: number,
	untilMs: number,
): void {
	stateFor(vendor).cooldown = { reason, startedAtMs, untilMs };
}

/** Epoch ms until which the vendor is skipped, or undefined when no cooldown is active. */
export function resolverVendorCooldownUntilMs(
	vendor: ProviderResolverVendor,
	nowMs: number,
): number | undefined {
	const state = vendorHealth.get(vendor);
	if (!state?.cooldown) return undefined;
	if (state.cooldown.untilMs <= nowMs) {
		state.cooldown = undefined;
		return undefined;
	}
	return state.cooldown.untilMs;
}

export function recordResolverVendorBalance(
	vendor: ProviderResolverVendor,
	result:
		| { readonly balance: number; readonly checkedAtMs: number }
		| {
				readonly error: ResolverVendorUnavailableReason | "unexpected";
				readonly checkedAtMs: number;
		  },
): void {
	const state = stateFor(vendor);
	if ("balance" in result) {
		state.balance = { amount: result.balance, checkedAtMs: result.checkedAtMs };
		state.balanceError = undefined;
		return;
	}
	state.balanceError = { reason: result.error, checkedAtMs: result.checkedAtMs };
}

export function recordResolverVendorDetachedOutcome(
	vendor: ProviderResolverVendor,
	outcome: "completed" | "failed",
): void {
	const state = stateFor(vendor);
	if (outcome === "completed") state.detachedCompleted += 1;
	else state.detachedFailed += 1;
}

/** Snapshot of every vendor the resolver has touched in this process; safe to publish. */
export function getResolverVendorHealthSnapshot(
	nowMs: number = Date.now(),
): readonly ResolverVendorHealthSnapshot[] {
	return [...vendorHealth.entries()].map(([vendor, state]) => {
		const cooldownUntilMs = resolverVendorCooldownUntilMs(vendor, nowMs);
		return {
			vendor,
			...(state.balance ? { balance: { ...state.balance } } : {}),
			...(state.balanceError ? { balanceError: { ...state.balanceError } } : {}),
			...(cooldownUntilMs !== undefined && state.cooldown
				? { cooldown: { ...state.cooldown } }
				: {}),
			solves: [...state.solves.entries()].map(([kind, window]) => solveStats(kind, window)),
			detached: { completed: state.detachedCompleted, failed: state.detachedFailed },
		};
	});
}

/** Internal test seam; deliberately not re-exported from the package root. */
export function resetResolverVendorHealthForTests(): void {
	vendorHealth.clear();
}
