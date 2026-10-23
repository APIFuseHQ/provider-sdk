import { describe, expect, it } from "bun:test";
import { PROVIDER_OBSERVABILITY_TAXONOMY_VERSION } from "../observability.js";

type Observability = {
	category?: string;
	taxonomyVersion?: string;
	retryable?: boolean;
	upstreamStatus?: number;
};
type ErrorBody = {
	error?: {
		code?: string;
		message?: string;
		requestId?: string;
		source?: string;
		retryable?: boolean;
	};
};
type CauseFrame = { errorClass?: string; code?: string };
type FailureLog = {
	event?: string;
	status?: number;
	code?: string;
	errorClass?: string;
	errorCategory?: string;
	retryable?: boolean;
	causeChain?: CauseFrame[];
};
type SourceSaw = { errorClass: string; code?: string; status?: number };
type Scenario = {
	source?: SourceSaw;
	served?: { status: number; observability: Observability | null; body: ErrorBody };
	log?: FailureLog;
};
type ThrownSummary = { errorClass: string; code?: unknown; causes: ThrownSummary[] };
type SourcePodScenario = {
	caller: { status: number; observability: Observability | null; body: ErrorBody };
	thrown?: ThrownSummary;
	log?: FailureLog;
	owner?: { status: number; observability: Observability | null; body: ErrorBody };
};
type Wire = Record<
	| "deadline-http"
	| "deadline-stealth"
	| "deadline-then-source-leaves"
	| "source-leaves-before-deadline"
	| "direct-caller-leaves"
	| "provider-abort"
	| "upstream-503",
	Scenario
> &
	Record<
		| "source-deadline-aborts-forward"
		| "source-receives-owner-deadline"
		| "source-owner-down"
		| "source-owner-resets",
		SourcePodScenario
	>;

// A real owner pod (the provider app behind a real local listener) receiving
// signed envelopes from the SDK's real HTTP forwarder, its operations reading
// a real local upstream that holds the read open. Run in a subprocess so the
// wreq-js module mock in stealth-client.test.ts cannot replace the stealth
// transport.
async function runWire(): Promise<Wire> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/serve-stateful-deadline-wire.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`stateful deadline wire fixture failed: ${stderr}`);
	return JSON.parse(stdout);
}

const wire = await runWire();

function outcome(scenario: Scenario) {
	return {
		status: scenario.served?.status,
		category: scenario.served?.observability?.category,
		retryable: scenario.served?.observability?.retryable,
		source: scenario.served?.body.error?.source,
		bodyRetryable: scenario.served?.body.error?.retryable,
		logStatus: scenario.log?.status,
		logCategory: scenario.log?.errorCategory,
		logRetryable: scenario.log?.retryable,
	};
}

// What the route already serves for a forwarded deadline that expired before
// execution (serve-stateful-forwarding.test.ts): the deadline's own code, 504,
// timeout, APIFuse-owned, not retryable.
const DEADLINE_EXPIRED_OUTCOME = {
	status: 504,
	category: "timeout",
	retryable: false,
	source: "apifuse",
	bodyRetryable: false,
	logStatus: 504,
	logCategory: "timeout",
	logRetryable: false,
};

describe("stateful forwarding deadline expiring mid-operation", () => {
	for (const scenario of ["deadline-http", "deadline-stealth"] as const) {
		it(`serves ${scenario} as the forwarded deadline, not an upstream failure`, () => {
			const result = wire[scenario];
			expect(outcome(result)).toEqual(DEADLINE_EXPIRED_OUTCOME);
			expect(result.served?.observability).toEqual({
				category: "timeout",
				taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
				retryable: false,
			});
			expect(result.served?.body).toEqual({
				error: {
					code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
					message: "Stateful forwarding deadline expired.",
					requestId: scenario,
					retryable: false,
					source: "apifuse",
				},
			});
			expect(result.log?.code).toBe("STATEFUL_FORWARDING_DEADLINE_EXPIRED");
			expect(result.log?.errorClass).toBe("StatefulRoutingDeadlineError");
			// The cancelled read stays visible as the cause: the transport's
			// transport_cancelled, caused by the deadline's own TimeoutError.
			expect(result.log?.causeChain?.slice(0, 2)).toEqual([
				expect.objectContaining({ errorClass: "TransportError", code: "transport_cancelled" }),
				expect.objectContaining({ errorClass: "TimeoutError" }),
			]);
			// The source pod's forwarder receives the deadline's code and status.
			expect(result.source).toEqual({
				errorClass: "StatefulOwnerForwardingError",
				code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
				status: 504,
			});
		});
	}

	it("keeps a deadline that fired first on the deadline even after the source leaves", () => {
		const result = wire["deadline-then-source-leaves"];
		// The source left after the deadline had cancelled the read, so the
		// forwarder saw its own aborted request, and the owner classified the
		// failure with its inbound request already aborted.
		expect(result.source).toEqual({
			errorClass: "StatefulOwnerForwardingError",
			code: "STATEFUL_FORWARDING_REQUEST_FAILED",
		});
		expect(outcome(result)).toEqual(DEADLINE_EXPIRED_OUTCOME);
		expect(result.served?.body.error?.code).toBe("STATEFUL_FORWARDING_DEADLINE_EXPIRED");
		expect(result.log?.code).toBe("STATEFUL_FORWARDING_DEADLINE_EXPIRED");
		expect(result.log?.causeChain?.[1]?.errorClass).toBe("TimeoutError");
	});

	it("leaves a source that left before the deadline to the caller-cancellation classification", () => {
		const result = wire["source-leaves-before-deadline"];
		const direct = wire["direct-caller-leaves"];
		// The cancellation came from the inbound request, not the deadline.
		expect(result.source?.code).toBe("STATEFUL_FORWARDING_REQUEST_FAILED");
		expect(result.log?.code).toBe("transport_cancelled");
		expect(result.served?.body.error?.code).toBe("transport_cancelled");
		expect(result.log?.causeChain?.[0]?.errorClass).toBe("AbortError");
		// Classified exactly like a caller leaving the ordinary operation route.
		expect(direct.log?.code).toBe("transport_cancelled");
		expect(outcome(result)).toEqual(outcome(direct));
		expect(result.served?.observability).toEqual(direct.served?.observability ?? null);
		expect(outcome(result)).toEqual({
			status: 400,
			category: "client_cancelled",
			retryable: false,
			source: "client",
			bodyRetryable: false,
			logStatus: 400,
			logCategory: "client_cancelled",
			logRetryable: false,
		});
	});

	it("keeps a provider's own per-request abort off the deadline", () => {
		const result = wire["provider-abort"];
		expect(result.log?.code).toBe("transport_cancelled");
		expect(result.log?.causeChain?.[0]?.errorClass).toBe("TimeoutError");
		expect(result.served?.observability).toEqual({
			category: "upstream_http",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: false,
		});
		expect(outcome(result)).toEqual({
			status: 502,
			category: "upstream_http",
			retryable: false,
			source: "upstream_failure",
			bodyRetryable: false,
			logStatus: 502,
			logCategory: "upstream_http",
			logRetryable: false,
		});
	});

	it("leaves an upstream HTTP failure on the upstream_http branch", () => {
		const result = wire["upstream-503"];
		expect(result.log?.code).toBe("upstream_http_error");
		expect(result.served?.observability).toEqual({
			category: "upstream_http",
			taxonomyVersion: PROVIDER_OBSERVABILITY_TAXONOMY_VERSION,
			retryable: true,
			upstreamStatus: 503,
		});
		expect(outcome(result)).toEqual({
			status: 502,
			category: "upstream_http",
			retryable: true,
			source: "upstream_failure",
			bodyRetryable: true,
			logStatus: 502,
			logCategory: "upstream_http",
			logRetryable: true,
		});
		expect(result.source).toEqual({
			errorClass: "StatefulOwnerForwardingError",
			code: "upstream_http_error",
			status: 502,
		});
	});
});

function callerOutcome(scenario: SourcePodScenario) {
	return {
		status: scenario.caller.status,
		category: scenario.caller.observability?.category,
		retryable: scenario.caller.observability?.retryable,
		code: scenario.caller.body.error?.code,
		source: scenario.caller.body.error?.source,
		bodyRetryable: scenario.caller.body.error?.retryable,
		logStatus: scenario.log?.status,
		logCode: scenario.log?.code,
		logCategory: scenario.log?.errorCategory,
		logErrorClass: scenario.log?.errorClass,
	};
}

// What the caller of the source pod receives when the forwarded deadline
// expires: the same 504 the owner serves for it.
const CALLER_DEADLINE_EXPIRED = {
	status: 504,
	category: "timeout",
	retryable: false,
	code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
	source: "apifuse",
	bodyRetryable: false,
	logStatus: 504,
	logCode: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
	logCategory: "timeout",
	logErrorClass: "StatefulRoutingDeadlineError",
};

// A forwarding failure the source pod's serve mapper does not classify.
const CALLER_UNCLASSIFIED_FORWARDING_FAILURE = {
	status: 500,
	category: "internal_error",
	retryable: false,
	code: "internal_error",
	source: "apifuse",
	bodyRetryable: false,
	logStatus: 500,
	logCode: "internal_error",
	logCategory: "internal_error",
	logErrorClass: "StatefulOwnerForwardingError",
};

describe("stateful forwarding deadline as the source pod's caller sees it", () => {
	it("serves the deadline when the source's own deadline timer aborts the forwarding request", () => {
		const result = wire["source-deadline-aborts-forward"];
		expect(callerOutcome(result)).toEqual(CALLER_DEADLINE_EXPIRED);
		expect(result.caller.body).toEqual({
			error: {
				code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
				message: "Stateful forwarding deadline expired.",
				requestId: "source-deadline-aborts-forward",
				retryable: false,
				source: "apifuse",
			},
		});
		// The router's timer, scheduled from deadlineAt, aborted the forwarding
		// fetch before the owner answered: the forwarder's own failure, caused
		// by that timer's AbortError, is kept as the deadline's cause.
		expect(result.thrown).toEqual({
			errorClass: "StatefulRoutingDeadlineError",
			causes: [
				{
					errorClass: "StatefulOwnerForwardingError",
					code: "STATEFUL_FORWARDING_REQUEST_FAILED",
					causes: [expect.objectContaining({ errorClass: "AbortError" })],
				},
			],
		});
		expect(result.log?.causeChain?.map((frame) => frame.errorClass)).toEqual([
			"StatefulOwnerForwardingError",
			"AbortError",
		]);
	});

	it("serves the deadline when the owner's deadline response reaches the source first", () => {
		const result = wire["source-receives-owner-deadline"];
		// The source's clock runs 300 ms behind, so the owner's 504 arrives
		// before the source's timer fires and the forwarder relays its code.
		expect(result.owner?.status).toBe(504);
		expect(result.owner?.body.error?.code).toBe("STATEFUL_FORWARDING_DEADLINE_EXPIRED");
		expect(callerOutcome(result)).toEqual(CALLER_DEADLINE_EXPIRED);
		expect(result.thrown).toEqual({
			errorClass: "StatefulRoutingDeadlineError",
			causes: [
				{
					errorClass: "StatefulOwnerForwardingError",
					code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
					causes: [],
				},
			],
		});
	});

	for (const [scenario, cause] of [
		["source-owner-down", "ConnectionRefused"],
		["source-owner-resets", "ECONNRESET"],
	] as const) {
		it(`keeps ${scenario} a forwarding failure, not the deadline`, () => {
			const result = wire[scenario];
			// Before the deadline: the forwarder's own request failed.
			expect(result.thrown).toEqual({
				errorClass: "StatefulOwnerForwardingError",
				code: "STATEFUL_FORWARDING_REQUEST_FAILED",
				causes: [expect.objectContaining({ code: cause })],
			});
			// Unchanged by this fix: the source's serve mapper has no branch for
			// a forwarding failure.
			expect(callerOutcome(result)).toEqual(CALLER_UNCLASSIFIED_FORWARDING_FAILURE);
		});
	}
});
