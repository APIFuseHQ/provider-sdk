import { AsyncLocalStorage } from "node:async_hooks";
import type { ProxyVendorName } from "../config/loader.js";
import {
	getProxyVendorSelector,
	type ProxyAttemptOutcome,
	type ProxyVendorSelector,
	setProxyVendorSelector,
	staticOrderProxyVendorSelector,
} from "./proxy-vendor-selector.js";

/**
 * Adaptive vendor selector: a circuit breaker per vendor on top of the vendor
 * selector seam. The static selector's even split of the attempt budget stays
 * the baseline (it is what makes the fallback reachable inside the budget); a
 * vendor whose recent attempts failed for reasons attributable to it is
 * ejected (opened) for a growing period and removed from that baseline, the
 * next vendor in the chain serves meanwhile, and one probe attempt after the
 * period decides whether the vendor returns. The shape follows Envoy outlier
 * detection (consecutive failures, base ejection time multiplied by
 * consecutive ejections, capped) and Finagle failure accrual (one probe
 * request revives a dead endpoint).
 *
 * The selector is process-local: every vendor's state lives in this process
 * only, like every library this follows. It starts closed (chain order) and
 * learns from the reports the resolver and the transports already send.
 *
 * `serve()` registers it for the process through
 * `installProcessProxyVendorSelector` unless `PROXY_VENDOR_SELECTION_ENV` says
 * `ordered`, which keeps the static declaration order.
 */

/** Which selector a process runs; read from `PROXY_VENDOR_SELECTION_ENV`. */
export type ProxyVendorSelectionMode = "ordered" | "adaptive";

export const PROXY_VENDOR_SELECTION_ENV = "APIFUSE__PROXY__VENDOR_SELECTION";

/** Selection a served process runs when `PROXY_VENDOR_SELECTION_ENV` is unset or unrecognised. */
export const DEFAULT_PROXY_VENDOR_SELECTION_MODE: ProxyVendorSelectionMode = "adaptive";

/**
 * Parse the selection mode from an environment value. Unset, empty and
 * unknown values fall back to `fallback` so a typo can never silently switch
 * selectors; the caller decides what the fallback is.
 */
export function resolveProxyVendorSelectionMode(
	value: string | undefined,
	fallback: ProxyVendorSelectionMode,
): ProxyVendorSelectionMode {
	const normalized = value?.trim().toLowerCase();
	return normalized === "ordered" || normalized === "adaptive" ? normalized : fallback;
}

/**
 * What the selector learns from one `ProxyAttemptOutcome`.
 *
 * - `ok`: the vendor carried the attempt. A delivered upstream response is a
 *   vendor success whatever its status.
 * - `vendor_failure`: attributable to the vendor (could not synthesize a proxy,
 *   tunnel never opened, proxy-level refusal, network error through the proxy).
 * - `other_failure`: not attributable (configuration, cancellation, timeout).
 */
export type ProxyVendorAttemptOutcome = "ok" | "vendor_failure" | "other_failure";

/**
 * Error codes that count against the vendor that carried the attempt.
 * `PROXY_AUTH_IP_DENIED` is included on purpose: every endpoint of that vendor
 * refuses the same egress IP, so the vendor is unusable until its allowlist
 * changes, which is exactly what the selector should route around.
 */
export const PROXY_VENDOR_FAILURE_ERROR_CODES = [
	"PROXY_ALLOCATION_FAILED",
	"proxy_connect_failed",
	"PROXY_POOL_STALE",
	"PROXY_EDGE_AUTH_REJECTED",
	"PROXY_EDGE_TLS_REJECTED",
	"PROXY_AUTH_IP_DENIED",
] as const;

/**
 * Codes the transport cannot attribute on its own: the tunnel may have opened
 * and the origin may have reset or stalled. A plain network error through a
 * proxy counts against the vendor (with raw CONNECT the socket the transport
 * sees is the proxy's); a timeout does not, because the per-attempt timeout is
 * sized for legitimately slow origins and a stalled origin would otherwise
 * eject a healthy vendor.
 */
export const PROXY_VENDOR_AMBIGUOUS_ERROR_CODES = [
	"transport_network_error",
	"transport_timeout",
] as const;
const PROXY_VENDOR_AMBIGUOUS_FAILURE_CODES: ReadonlySet<string> = new Set([
	"transport_network_error",
]);

/** Resolution-phase codes that describe this process's configuration, not the vendor. */
const RESOLUTION_CONFIGURATION_CODES: ReadonlySet<string> = new Set([
	"no_credentials",
	"protocol_unsupported",
	"PROXY_REQUIRED",
	"PROXY_PROTOCOL_UNSUPPORTED",
]);

/**
 * Vendor-failure boundary of the adaptive selector. `phase: "resolution"`
 * errors are vendor failures unless they describe configuration; a transport
 * error without an error code is a delivered upstream status (the native HTTP
 * transport reports 4xx/5xx that way) and therefore a vendor success.
 */
export function classifyProxyVendorAttemptOutcome(
	outcome: Pick<ProxyAttemptOutcome, "phase" | "outcome" | "errorCode">,
): ProxyVendorAttemptOutcome {
	if (outcome.outcome === "ok") return "ok";
	const code = outcome.errorCode;
	if (outcome.phase === "resolution") {
		return code !== undefined && RESOLUTION_CONFIGURATION_CODES.has(code)
			? "other_failure"
			: "vendor_failure";
	}
	if (code === undefined || code === "upstream_http_error") return "ok";
	if ((PROXY_VENDOR_FAILURE_ERROR_CODES as readonly string[]).includes(code)) {
		return "vendor_failure";
	}
	return PROXY_VENDOR_AMBIGUOUS_FAILURE_CODES.has(code) ? "vendor_failure" : "other_failure";
}

export type ProxyVendorState = "closed" | "open" | "half_open";

/**
 * Breaker values. The defaults are the library defaults the design cites
 * (Envoy outlier detection: 5 consecutive failures, 30 s base ejection time
 * growing with consecutive ejections up to 300 s, multiplier decays every
 * 10 s interval; Finagle failure accrual: one probe request revives). They are
 * the proposed bundle, not measurements, and every value is overridable.
 */
export type AdaptiveProxyVendorSelectorOptions = {
	/** Consecutive vendor failures that open the breaker. */
	readonly consecutiveFailureThreshold?: number;
	/** Open duration for the first ejection; multiplied by the number of consecutive ejections. */
	readonly baseOpenMs?: number;
	/** Longest open duration, whatever the multiplier. */
	readonly maxOpenMs?: number;
	/** While closed, the ejection multiplier decays by one every interval. */
	readonly ejectionDecayIntervalMs?: number;
	/**
	 * How long a half-open probe may stay unreported before another probe is
	 * allowed; guards against an attempt that never reaches the transport.
	 */
	readonly probeTimeoutMs?: number;
	/** Observation hook for every state transition. */
	readonly onTransition?: (event: ProxyVendorStateTransition) => void;
};

export const ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS: Required<
	Omit<AdaptiveProxyVendorSelectorOptions, "onTransition">
> = {
	consecutiveFailureThreshold: 5,
	baseOpenMs: 30_000,
	maxOpenMs: 300_000,
	ejectionDecayIntervalMs: 10_000,
	probeTimeoutMs: 30_000,
};

export type ProxyVendorSelectionReason =
	/** Every vendor ahead in the chain is closed (or the selector is cold). */
	| "chain_order"
	/** A vendor ahead in the chain is open and was skipped. */
	| "vendor_open"
	/** The first directive is the single probe of a half-open vendor. */
	| "half_open_probe"
	/** Every vendor is open or probing; the chain order is used as is (fail open). */
	| "all_open";

export type ProxyVendorHealthSnapshot = {
	readonly vendor: ProxyVendorName;
	readonly state: ProxyVendorState;
	readonly consecutiveFailures: number;
	/** Consecutive ejections; the open-duration multiplier. */
	readonly ejections: number;
	/** Epoch milliseconds the open period ends; present while open. */
	readonly openUntil?: number;
	/** Epoch milliseconds the in-flight probe was issued; present while probing. */
	readonly probeIssuedAt?: number;
};

export type ProxyVendorStateTransition = {
	readonly vendor: ProxyVendorName;
	readonly from: ProxyVendorState;
	readonly to: ProxyVendorState;
	readonly reason:
		| "failure_threshold"
		| "open_elapsed"
		| "probe_succeeded"
		| "probe_failed"
		| "probe_timed_out";
	readonly now: number;
	readonly consecutiveFailures: number;
	readonly ejections: number;
	readonly openUntil?: number;
	readonly errorCode?: string;
};

export interface AdaptiveProxyVendorSelector extends ProxyVendorSelector {
	readonly kind: "adaptive";
	/** The reason behind the most recent `select` call, for telemetry. */
	lastSelectionReason(): ProxyVendorSelectionReason;
	/** Bounded, low-cardinality view of every vendor the selector has seen. */
	snapshot(now?: number): readonly ProxyVendorHealthSnapshot[];
	/** Forget every vendor; tests and a manual reset use it. */
	reset(): void;
}

/** One vendor's state as the selector saw it when it routed an attempt. */
export type ProxyVendorSelectionVendorState = {
	readonly vendor: ProxyVendorName;
	readonly state: ProxyVendorState;
	/** Consecutive ejections; the open-duration multiplier. */
	readonly ejections: number;
};

/** What one `select` call decided, for the proxy telemetry of the request that made it. */
export type ProxyVendorSelectionObservation = {
	readonly kind: "adaptive";
	readonly reason: ProxyVendorSelectionReason;
	/** The request's chain, in declaration order. */
	readonly vendorStates: readonly ProxyVendorSelectionVendorState[];
};

/** Receives the selections made while one request runs. */
export interface ProxyVendorSelectionSink {
	recordProxyVendorSelection(observation: ProxyVendorSelectionObservation): void;
}

const selectionScopes = new AsyncLocalStorage<ProxyVendorSelectionSink>();

/**
 * Runs `fn` with `sink` receiving every adaptive selection made inside it. The
 * selector is process-wide, so its own `lastSelectionReason()` can belong to a
 * concurrent request; the scope ties each selection to the request that asked.
 */
export function observeProxyVendorSelections<T>(
	sink: ProxyVendorSelectionSink | undefined,
	fn: () => T,
): T {
	return sink ? selectionScopes.run(sink, fn) : fn();
}

/** Observation never fails the attempt it describes. */
function publishSelection(build: () => ProxyVendorSelectionObservation): void {
	const sink = selectionScopes.getStore();
	if (!sink) return;
	try {
		sink.recordProxyVendorSelection(build());
	} catch {
		// A telemetry sink is an observer.
	}
}

type VendorRecord = {
	state: ProxyVendorState;
	consecutiveFailures: number;
	ejections: number;
	openUntil: number | undefined;
	probeIssuedAt: number | undefined;
	/** Last instant the multiplier decayed while closed. */
	decayedAt: number | undefined;
};

function positive(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createAdaptiveProxyVendorSelector(
	options: AdaptiveProxyVendorSelectorOptions = {},
): AdaptiveProxyVendorSelector {
	const threshold = Math.max(
		1,
		Math.floor(
			positive(
				options.consecutiveFailureThreshold,
				ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS.consecutiveFailureThreshold,
			),
		),
	);
	const baseOpenMs = positive(
		options.baseOpenMs,
		ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS.baseOpenMs,
	);
	const maxOpenMs = Math.max(
		baseOpenMs,
		positive(options.maxOpenMs, ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS.maxOpenMs),
	);
	const decayIntervalMs = positive(
		options.ejectionDecayIntervalMs,
		ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS.ejectionDecayIntervalMs,
	);
	const probeTimeoutMs = positive(
		options.probeTimeoutMs,
		ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS.probeTimeoutMs,
	);
	const records = new Map<ProxyVendorName, VendorRecord>();
	let lastReason: ProxyVendorSelectionReason = "chain_order";

	const record = (vendor: ProxyVendorName): VendorRecord => {
		let entry = records.get(vendor);
		if (!entry) {
			entry = {
				state: "closed",
				consecutiveFailures: 0,
				ejections: 0,
				openUntil: undefined,
				probeIssuedAt: undefined,
				decayedAt: undefined,
			};
			records.set(vendor, entry);
		}
		return entry;
	};

	const transition = (
		vendor: ProxyVendorName,
		entry: VendorRecord,
		to: ProxyVendorState,
		reason: ProxyVendorStateTransition["reason"],
		now: number,
		errorCode?: string,
	): void => {
		const from = entry.state;
		entry.state = to;
		options.onTransition?.({
			vendor,
			from,
			to,
			reason,
			now,
			consecutiveFailures: entry.consecutiveFailures,
			ejections: entry.ejections,
			...(entry.openUntil === undefined ? {} : { openUntil: entry.openUntil }),
			...(errorCode === undefined ? {} : { errorCode }),
		});
	};

	/** Apply the time-driven transitions (open elapsed, probe timed out, multiplier decay). */
	const advance = (vendor: ProxyVendorName, entry: VendorRecord, now: number): void => {
		if (entry.state === "open" && entry.openUntil !== undefined && now >= entry.openUntil) {
			entry.openUntil = undefined;
			transition(vendor, entry, "half_open", "open_elapsed", now);
		}
		if (
			entry.state === "half_open" &&
			entry.probeIssuedAt !== undefined &&
			now - entry.probeIssuedAt >= probeTimeoutMs
		) {
			entry.probeIssuedAt = undefined;
			transition(vendor, entry, "half_open", "probe_timed_out", now);
		}
		if (entry.state === "closed" && entry.ejections > 0) {
			const since = entry.decayedAt ?? now;
			const steps = Math.floor((now - since) / decayIntervalMs);
			if (steps > 0) {
				entry.ejections = Math.max(0, entry.ejections - steps);
				entry.decayedAt = since + steps * decayIntervalMs;
			} else if (entry.decayedAt === undefined) {
				entry.decayedAt = now;
			}
		}
	};

	const open = (vendor: ProxyVendorName, entry: VendorRecord, now: number, errorCode?: string) => {
		const from = entry.state;
		entry.ejections += 1;
		entry.openUntil = now + Math.min(maxOpenMs, baseOpenMs * entry.ejections);
		entry.probeIssuedAt = undefined;
		entry.decayedAt = undefined;
		transition(
			vendor,
			entry,
			"open",
			from === "half_open" ? "probe_failed" : "failure_threshold",
			now,
			errorCode,
		);
		// The streak that opened the breaker is reported on the transition; the
		// count starts again when the vendor is probed.
		entry.consecutiveFailures = 0;
	};

	/** Closed, or half-open with no probe in flight. */
	const available = (vendor: ProxyVendorName): boolean => {
		const entry = record(vendor);
		return (
			entry.state === "closed" || (entry.state === "half_open" && entry.probeIssuedAt === undefined)
		);
	};

	const publish = (reason: ProxyVendorSelectionReason, chain: readonly ProxyVendorName[]): void => {
		publishSelection(() => ({
			kind: "adaptive",
			reason,
			vendorStates: chain.map((vendor) => {
				const entry = record(vendor);
				return { vendor, state: entry.state, ejections: entry.ejections };
			}),
		}));
	};

	return {
		kind: "adaptive",
		select(request) {
			if (request.chain.length === 0) {
				lastReason = "chain_order";
				return [];
			}
			const now = request.now;
			for (const vendor of request.chain) advance(vendor, record(vendor), now);
			// The static split of the attempt budget is the baseline: it is what makes
			// the fallback reachable inside the budget when the primary keeps failing
			// below the breaker threshold. The breaker only removes vendors from it.
			const baseline = staticOrderProxyVendorSelector.select(request);
			const head = baseline.find((directive) => available(directive.vendor));
			if (!head) {
				// Fail open: nothing is known to be healthy, so the declared order stands.
				lastReason = "all_open";
				publish("all_open", request.chain);
				return baseline;
			}
			const headEntry = record(head.vendor);
			const headIndex = request.chain.indexOf(head.vendor);
			const aheadUnavailable = request.chain
				.slice(0, headIndex)
				.some((vendor) => !available(vendor));
			let probing = false;
			if (headEntry.state === "half_open") {
				// This attempt is the probe; a second probe waits for its report.
				headEntry.probeIssuedAt = now;
				probing = true;
			}
			lastReason = probing ? "half_open_probe" : aheadUnavailable ? "vendor_open" : "chain_order";
			publish(lastReason, request.chain);
			const tail = baseline.filter(
				(directive) => directive.vendor !== head.vendor && available(directive.vendor),
			);
			return [
				{
					vendor: head.vendor,
					// A vendor serving because one ahead of it is unavailable takes the whole
					// budget, so every attempt of the request derives a new session on it;
					// otherwise it keeps its static share.
					vendorAttempt: aheadUnavailable ? request.attempt : head.vendorAttempt,
					session: head.session,
				},
				...tail,
			];
		},
		report(outcome) {
			const entry = record(outcome.vendor);
			const now = outcome.now;
			advance(outcome.vendor, entry, now);
			const learned = classifyProxyVendorAttemptOutcome(outcome);
			if (learned === "other_failure") {
				// Inconclusive for the vendor; a probe may be issued again.
				if (entry.state === "half_open") entry.probeIssuedAt = undefined;
				return;
			}
			if (learned === "ok") {
				entry.consecutiveFailures = 0;
				if (entry.state === "half_open") {
					entry.probeIssuedAt = undefined;
					entry.decayedAt = now;
					transition(outcome.vendor, entry, "closed", "probe_succeeded", now);
				}
				return;
			}
			if (entry.state === "open") return;
			entry.consecutiveFailures += 1;
			if (entry.state === "half_open" || entry.consecutiveFailures >= threshold) {
				open(outcome.vendor, entry, now, outcome.errorCode);
			}
		},
		lastSelectionReason() {
			return lastReason;
		},
		snapshot(now = Date.now()) {
			return [...records.entries()].map(([vendor, entry]) => {
				advance(vendor, entry, now);
				return {
					vendor,
					state: entry.state,
					consecutiveFailures: entry.consecutiveFailures,
					ejections: entry.ejections,
					...(entry.openUntil === undefined ? {} : { openUntil: entry.openUntil }),
					...(entry.probeIssuedAt === undefined ? {} : { probeIssuedAt: entry.probeIssuedAt }),
				};
			});
		},
		reset() {
			records.clear();
			lastReason = "chain_order";
		},
	};
}

/** The selector a served process installed, shared by every server that installed it. */
type ProcessAdaptiveInstallation = {
	readonly selector: AdaptiveProxyVendorSelector;
	readonly transitionListeners: Set<(event: ProxyVendorStateTransition) => void>;
	holders: number;
};

let processInstallation: ProcessAdaptiveInstallation | undefined;

export type ProcessProxyVendorSelection = {
	/** Mode read from the environment (`DEFAULT_PROXY_VENDOR_SELECTION_MODE` when unset). */
	readonly mode: ProxyVendorSelectionMode;
	/** Selector in force for the process after the call. */
	readonly selector: ProxyVendorSelector;
	/**
	 * Undo this installation. The static order returns once every server that
	 * installed the adaptive selector released it; a selector registered by
	 * someone else meanwhile is left alone.
	 */
	release(): void;
};

export type InstallProcessProxyVendorSelectorOptions = {
	/** Defaults to `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Receives every state transition of the process selector while installed. */
	readonly onTransition?: (event: ProxyVendorStateTransition) => void;
};

/**
 * Register the selector named by `PROXY_VENDOR_SELECTION_ENV` for this process.
 * `adaptive` (the default) installs one adaptive selector shared by every
 * server in the process; `ordered` leaves the static declaration order. A
 * selector that the host registered itself (anything other than the static
 * one) is never replaced.
 */
export function installProcessProxyVendorSelector(
	options: InstallProcessProxyVendorSelectorOptions = {},
): ProcessProxyVendorSelection {
	const env = options.env ?? process.env;
	const mode = resolveProxyVendorSelectionMode(
		env[PROXY_VENDOR_SELECTION_ENV],
		DEFAULT_PROXY_VENDOR_SELECTION_MODE,
	);
	const current = getProxyVendorSelector();
	if (processInstallation && current !== processInstallation.selector) {
		// Replaced after it was installed: the replacement owns the process now.
		processInstallation = undefined;
	}
	if (mode === "ordered" || (!processInstallation && current !== staticOrderProxyVendorSelector)) {
		return { mode, selector: current, release: () => {} };
	}
	if (!processInstallation) {
		const transitionListeners = new Set<(event: ProxyVendorStateTransition) => void>();
		const selector = createAdaptiveProxyVendorSelector({
			onTransition(event) {
				for (const listener of transitionListeners) {
					try {
						listener(event);
					} catch {
						// A transition log line is an observer.
					}
				}
			},
		});
		processInstallation = { selector, transitionListeners, holders: 0 };
		setProxyVendorSelector(selector);
	}
	const installation = processInstallation;
	installation.holders += 1;
	const onTransition = options.onTransition;
	// One entry per installation, even when two servers share a logger.
	const listener = onTransition
		? (event: ProxyVendorStateTransition) => onTransition(event)
		: undefined;
	if (listener) installation.transitionListeners.add(listener);
	let released = false;
	return {
		mode,
		selector: installation.selector,
		release() {
			if (released) return;
			released = true;
			if (listener) installation.transitionListeners.delete(listener);
			installation.holders -= 1;
			if (installation.holders > 0 || processInstallation !== installation) return;
			processInstallation = undefined;
			if (getProxyVendorSelector() === installation.selector) setProxyVendorSelector(undefined);
		},
	};
}
